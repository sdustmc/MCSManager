import fs from "fs-extra";
import { StorageSubsystem as FileStorage } from "mcsmanager-common";
import { randomUUID } from "node:crypto";
import path from "node:path";
import StorageSubsystem from "../common/system_storage";
import type Instance from "../entity/instance/instance";
import { $t } from "../i18n";
import logger from "./log";
import storageQuotaService, { StorageQuotaService } from "./storage_quota_service";
import { pathsOverlap } from "./storage_quota_utils";

const JOURNAL_CATEGORY = "StorageQuotaOperation";
const MAX_JOURNAL_BYTES = 1024 * 1024;
const QUOTA_KEYS = [
  "maxSpace",
  "enableHardStorageQuota",
  "storageQuotaBufferPercent",
  "storageQuotaInodes",
  "storageQuotaWarningPercent",
  "storagePoolId",
  "storageQuotaProjectId"
] as const;

interface IQuotaSnapshot {
  cwd: string;
  processType: ProcessType;
  docker: IGlobalInstanceDockerConfig;
}

interface IQuotaJournal {
  version: 1 | 2;
  instanceUuid: string;
  previous: IQuotaSnapshot;
  next: IQuotaSnapshot;
  previousConfig?: IGlobalInstanceConfig;
}

export class StorageQuotaOperationService {
  private pending = new Map<string, Promise<void>>();
  private queue: Promise<void> = Promise.resolve();
  private stopping = false;
  private timer?: NodeJS.Timeout;
  private monitoring?: Promise<void>;

  constructor(private readonly quota: StorageQuotaService = storageQuotaService) {}

  public isApplying(instance: Instance) {
    return this.pending.has(instance.instanceUuid);
  }

  public hasPendingRecovery(instance: Instance) {
    return StorageSubsystem.fileExists(
      path.join(JOURNAL_CATEGORY, `${instance.instanceUuid}.json`)
    );
  }

  public assertIdle(instance: Instance) {
    if (this.stopping || this.isApplying(instance)) throw new Error($t("TXT_CODE_QUOTA_BUSY"));
    if (this.hasPendingRecovery(instance)) throw new Error($t("TXT_CODE_QUOTA_RECOVERY_REQUIRED"));
  }

  public assertWritable(instance: Instance) {
    this.assertIdle(instance);
    if (instance.status() === -1 || instance.status() === 2)
      throw new Error($t("TXT_CODE_QUOTA_INSTANCE_BUSY"));
    if (
      instance.config.docker.enableHardStorageQuota &&
      (!instance.config.docker.storageQuotaProjectId ||
        instance.info.storageQuota?.state !== "ready")
    )
      throw new Error(instance.info.storageQuota?.error || $t("TXT_CODE_QUOTA_NOT_APPLIED"));
  }

  private syncDirectory(directory: string) {
    if (process.platform !== "linux") return;
    const descriptor = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }

  private syncStoredFile(category: string, uuid: string) {
    const directory = path.join(FileStorage.DATA_PATH, category);
    const descriptor = fs.openSync(path.join(directory, `${uuid}.json`), "r");
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    this.syncDirectory(directory);
    this.syncDirectory(FileStorage.DATA_PATH);
  }

  private finishJournal(instance: Instance) {
    if (StorageSubsystem.fileExists(path.join("InstanceConfig", `${instance.instanceUuid}.json`)))
      this.syncStoredFile("InstanceConfig", instance.instanceUuid);
    StorageSubsystem.delete(JOURNAL_CATEGORY, instance.instanceUuid);
    this.syncDirectory(path.join(FileStorage.DATA_PATH, JOURNAL_CATEGORY));
  }

  private writeJournal(journal: IQuotaJournal) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(journal.instanceUuid))
      throw new Error($t("TXT_CODE_QUOTA_INVALID_CONFIG"));
    const text = JSON.stringify(journal);
    if (Buffer.byteLength(text) > MAX_JOURNAL_BYTES)
      throw new Error($t("TXT_CODE_QUOTA_INVALID_CONFIG"));
    const directory = path.join(FileStorage.DATA_PATH, JOURNAL_CATEGORY);
    const filePath = path.join(directory, `${journal.instanceUuid}.json`);
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    fs.ensureDirSync(directory, { mode: 0o700 });
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporaryPath, "wx", 0o600);
      fs.writeFileSync(descriptor, text);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporaryPath, filePath);
      this.syncDirectory(directory);
      this.syncDirectory(FileStorage.DATA_PATH);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      fs.removeSync(temporaryPath);
    }
  }

  private snapshot(config: IGlobalInstanceConfig): IQuotaSnapshot {
    const docker: IGlobalInstanceDockerConfig = {};
    for (const key of QUOTA_KEYS) (docker as any)[key] = config.docker[key];
    return { cwd: path.resolve(config.cwd), processType: config.processType, docker };
  }

  private async restore(
    instance: Instance,
    snapshot: IQuotaSnapshot,
    config?: IGlobalInstanceConfig
  ) {
    const restored = structuredClone(config ?? instance.config);
    restored.cwd = snapshot.cwd;
    restored.processType = snapshot.processType;
    for (const key of QUOTA_KEYS) (restored.docker as any)[key] = snapshot.docker[key];
    await instance.restoreConfig(restored);
  }

  private nextConfig(
    instance: Instance,
    patch: Partial<IGlobalInstanceConfig>
  ): IGlobalInstanceConfig {
    const next = {
      ...instance.config,
      ...patch,
      docker: { ...instance.config.docker, ...patch.docker }
    };
    if (typeof next.cwd !== "string" || next.cwd.length > 4096 || /[\0\r\n]/.test(next.cwd))
      throw new Error($t("TXT_CODE_QUOTA_UNSAFE_PATH"));
    next.cwd = path.resolve(next.cwd);
    // Project identifiers are assigned by the Daemon, never by an API client.
    next.docker.storageQuotaProjectId = instance.config.docker.storageQuotaProjectId;
    if (next.docker.enableHardStorageQuota && next.processType !== "docker")
      throw new Error($t("TXT_CODE_QUOTA_DOCKER_ONLY"));
    this.quota.validateConfig(next.docker);
    const previousPool = instance.config.docker.storagePoolId || "";
    const nextPool = next.docker.storagePoolId || "";
    if (nextPool !== previousPool) {
      const changedDirectory = next.cwd !== path.resolve(instance.config.cwd);
      if (nextPool || !changedDirectory)
        next.cwd = this.quota.resolvePoolDirectory(nextPool, instance.instanceUuid);
      if (
        !nextPool &&
        pathsOverlap(
          path.dirname(this.quota.resolvePoolDirectory(previousPool, instance.instanceUuid)),
          next.cwd
        )
      )
        throw new Error($t("TXT_CODE_QUOTA_POOL_DETACH_PATH"));
    }
    return next;
  }

  public changesQuota(instance: Instance, patch: Partial<IGlobalInstanceConfig>) {
    if (
      !QUOTA_KEYS.some(
        (key) =>
          key !== "storageQuotaProjectId" &&
          Object.prototype.hasOwnProperty.call(patch.docker || {}, key)
      ) &&
      patch.cwd === undefined &&
      patch.processType === undefined
    )
      return false;
    const next = this.nextConfig(instance, patch);
    const before = this.snapshot(instance.config);
    const after = this.snapshot(next);
    const managed =
      before.docker.enableHardStorageQuota ||
      before.docker.storageQuotaProjectId ||
      after.docker.enableHardStorageQuota ||
      before.docker.storagePoolId ||
      after.docker.storagePoolId;
    return Boolean(
      managed &&
        (QUOTA_KEYS.some(
          (key) => key !== "storageQuotaProjectId" && before.docker[key] !== after.docker[key]
        ) ||
          before.cwd !== after.cwd ||
          before.processType !== after.processType)
    );
  }

  public update(instance: Instance, patch: Partial<IGlobalInstanceConfig>, instances: Instance[]) {
    if (this.stopping) throw new Error($t("TXT_CODE_QUOTA_BUSY"));
    if (this.isApplying(instance)) throw new Error($t("TXT_CODE_QUOTA_BUSY"));
    if (instance.status() !== 0 && instance.status() !== 3)
      throw new Error($t("TXT_CODE_QUOTA_INSTANCE_BUSY"));
    const next = this.nextConfig(instance, patch);
    const previous = this.snapshot(instance.config);
    if (
      (previous.cwd !== next.cwd ||
        previous.processType !== next.processType ||
        Boolean(previous.docker.enableHardStorageQuota) !==
          Boolean(next.docker.enableHardStorageQuota)) &&
      instance.status() !== 0
    )
      throw new Error($t("TXT_CODE_fb547313"));
    const journal: IQuotaJournal = {
      version: 2,
      instanceUuid: instance.instanceUuid,
      previous,
      next: this.snapshot(next),
      previousConfig: { ...structuredClone(instance.config), cwd: previous.cwd }
    };
    if (StorageSubsystem.list(JOURNAL_CATEGORY).includes(instance.instanceUuid))
      throw new Error($t("TXT_CODE_QUOTA_RECOVERY_REQUIRED"));
    this.writeJournal(journal);
    this.launch(instance, async () => {
      let touched = false;
      let changedConfig = false;
      try {
        const oldWorkspace = this.quota.resolveDockerDiskWorkspace(instance);
        const shadow = Object.assign(Object.create(instance), { config: next });
        const workspace = this.quota.resolveDockerDiskWorkspace(shadow);
        if (
          previous.cwd !== next.cwd &&
          (await fs.pathExists(oldWorkspace)) &&
          (await fs.readdir(oldWorkspace)).length
        )
          throw new Error($t("TXT_CODE_QUOTA_POOL_MOVE"));
        if (next.docker.enableHardStorageQuota) {
          await this.quota.inspectWorkspace(
            workspace,
            `mcsm_${instance.instanceUuid.replace(/[^a-zA-Z0-9]/g, "")}`,
            true
          );
        }
        await fs.ensureDir(workspace);
        if (next.docker.enableHardStorageQuota)
          await this.quota.checkStoragePool(shadow, instances);
        changedConfig = true;
        await instance.updateConfig({ ...patch, cwd: next.cwd, docker: next.docker });
        if (
          (previous.docker.storageQuotaProjectId || previous.docker.enableHardStorageQuota) &&
          (previous.cwd !== next.cwd ||
            !next.docker.enableHardStorageQuota ||
            next.processType !== "docker")
        ) {
          touched = true;
          await this.quota.deleteDockerHardQuotaIfManaged(instance, oldWorkspace);
        }
        if (next.docker.enableHardStorageQuota) {
          touched = true;
          await this.quota.ensureDockerHardQuota(instance, workspace, Number(next.docker.maxSpace));
          instance.info.storageQuota = await this.quota.readUsage(instance, true);
          if (instance.info.storageQuota.state !== "ready")
            throw new Error(instance.info.storageQuota.error || $t("TXT_CODE_QUOTA_VERIFY_FAILED"));
          instance.info.storageUsage = instance.info.storageQuota.usedBytes;
          instance.info.storageLimit = instance.info.storageQuota.allocatedBytes;
        } else {
          instance.info.storageQuota = { state: "disabled" };
        }
        this.finishJournal(instance);
        logger.info("XFS quota operation completed:", instance.instanceUuid);
      } catch (error) {
        if (touched) await this.rollback(instance, journal);
        else {
          if (changedConfig) await this.restore(instance, previous, journal.previousConfig);
          this.finishJournal(instance);
        }
        throw error;
      }
    });
    return { instanceUuid: instance.instanceUuid, storageQuotaStatus: "applying" as const };
  }

  private async rollback(instance: Instance, journal: IQuotaJournal) {
    const shadow = Object.assign(Object.create(instance), {
      config: {
        ...instance.config,
        ...journal.previous,
        docker: { ...instance.config.docker, ...journal.previous.docker }
      }
    });
    try {
      if (journal.previous.cwd !== journal.next.cwd && journal.next.docker.enableHardStorageQuota) {
        await this.quota.deleteDockerHardQuotaIfManaged(
          instance,
          this.quota.resolveDockerDiskWorkspace(instance)
        );
      }
      if (journal.previous.docker.enableHardStorageQuota) {
        await this.restore(instance, journal.previous, journal.previousConfig);
        await this.quota.ensureDockerHardQuota(
          instance,
          this.quota.resolveDockerDiskWorkspace(shadow),
          Number(journal.previous.docker.maxSpace),
          { reinitialize: true, restore: true }
        );
      } else {
        const nextShadow = Object.assign(Object.create(instance), {
          config: {
            ...instance.config,
            ...journal.next,
            docker: { ...instance.config.docker, ...journal.next.docker }
          }
        });
        await this.quota.deleteDockerHardQuotaIfManaged(
          instance,
          this.quota.resolveDockerDiskWorkspace(nextShadow)
        );
        await this.restore(instance, journal.previous, journal.previousConfig);
      }
      this.finishJournal(instance);
    } catch (error) {
      logger.error("XFS quota rollback requires recovery:", instance.instanceUuid, error);
      throw new Error($t("TXT_CODE_QUOTA_RECOVERY_REQUIRED"));
    }
  }

  private launch(instance: Instance, operation: () => Promise<void>) {
    instance.info.storageQuota = {
      ...instance.info.storageQuota,
      state: "applying",
      error: undefined
    };
    const task = this.queue
      .then(async () => {
        if (this.stopping) throw new Error($t("TXT_CODE_QUOTA_RECOVERY_REQUIRED"));
        await operation();
      })
      .catch((error: Error) => {
        logger.error("Failed to apply XFS quota:", instance.instanceUuid, error);
        instance.info.storageQuota = {
          ...instance.info.storageQuota,
          state: "error",
          error: error.message
        };
      })
      .finally(() => this.pending.delete(instance.instanceUuid));
    this.queue = task;
    this.pending.set(instance.instanceUuid, task);
  }

  public retry(instance: Instance, instances: Instance[]) {
    if (this.stopping) throw new Error($t("TXT_CODE_QUOTA_BUSY"));
    if (this.isApplying(instance)) throw new Error($t("TXT_CODE_QUOTA_BUSY"));
    if (StorageSubsystem.list(JOURNAL_CATEGORY).includes(instance.instanceUuid)) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(instance.instanceUuid))
        throw new Error($t("TXT_CODE_QUOTA_RECOVERY_REQUIRED"));
      const journalPath = path.join(
        FileStorage.DATA_PATH,
        JOURNAL_CATEGORY,
        `${instance.instanceUuid}.json`
      );
      const journalStat = fs.lstatSync(journalPath);
      if (
        !journalStat.isFile() ||
        journalStat.isSymbolicLink() ||
        journalStat.size > MAX_JOURNAL_BYTES
      )
        throw new Error($t("TXT_CODE_QUOTA_RECOVERY_REQUIRED"));
      const text = StorageSubsystem.readFile(
        path.join(JOURNAL_CATEGORY, `${instance.instanceUuid}.json`)
      );
      let journal: IQuotaJournal;
      try {
        journal = JSON.parse(text);
      } catch {
        throw new Error($t("TXT_CODE_QUOTA_RECOVERY_REQUIRED"));
      }
      if (
        !journal ||
        (journal.version !== 1 && journal.version !== 2) ||
        journal.instanceUuid !== instance.instanceUuid ||
        !journal.previous?.docker ||
        !journal.next?.docker
      )
        throw new Error($t("TXT_CODE_QUOTA_RECOVERY_REQUIRED"));
      for (const snapshot of [journal.previous, journal.next]) {
        if (
          typeof snapshot.cwd !== "string" ||
          snapshot.cwd.length > 4096 ||
          !path.isAbsolute(snapshot.cwd) ||
          snapshot.cwd === path.parse(snapshot.cwd).root ||
          /[\0\r\n:]/.test(snapshot.cwd) ||
          !["docker", "general"].includes(snapshot.processType) ||
          Array.isArray(snapshot.docker) ||
          (snapshot.docker.storageQuotaProjectId != null &&
            (!Number.isSafeInteger(snapshot.docker.storageQuotaProjectId) ||
              snapshot.docker.storageQuotaProjectId < 1 ||
              snapshot.docker.storageQuotaProjectId > 0xffffffff))
        )
          throw new Error($t("TXT_CODE_QUOTA_RECOVERY_REQUIRED"));
        this.quota.validateConfig(snapshot.docker);
      }
      if (journal.version === 2) {
        const config = journal.previousConfig;
        if (
          !config ||
          typeof config !== "object" ||
          Array.isArray(config) ||
          typeof config.cwd !== "string" ||
          !config.docker ||
          typeof config.docker !== "object" ||
          Array.isArray(config.docker)
        )
          throw new Error($t("TXT_CODE_QUOTA_RECOVERY_REQUIRED"));
        const snapshot = this.snapshot(config);
        if (
          snapshot.cwd !== journal.previous.cwd ||
          snapshot.processType !== journal.previous.processType ||
          QUOTA_KEYS.some((key) => snapshot.docker[key] !== journal.previous.docker[key])
        )
          throw new Error($t("TXT_CODE_QUOTA_RECOVERY_REQUIRED"));
      }
      this.launch(instance, async () => {
        await this.rollback(instance, journal);
        if (instance.config.docker.enableHardStorageQuota)
          instance.info.storageQuota = await this.quota.readUsage(instance, true);
        else instance.info.storageQuota = { state: "disabled" };
      });
      return { instanceUuid: instance.instanceUuid, storageQuotaStatus: "applying" as const };
    }
    return this.update(instance, {}, instances);
  }

  public initialize(getInstances: () => Instance[]) {
    this.quota.setInstanceProvider(getInstances);
    for (const uuid of StorageSubsystem.list(JOURNAL_CATEGORY)) {
      const instance = getInstances().find((item) => item.instanceUuid === uuid);
      if (!instance) {
        logger.error("Quota recovery references a missing instance:", uuid);
        continue;
      }
      try {
        this.retry(instance, getInstances());
      } catch (error: any) {
        instance.info.storageQuota = { state: "error", error: error.message };
        logger.error("Failed to schedule XFS recovery:", uuid, error);
      }
    }
    const refresh = () => {
      if (this.stopping || this.monitoring) return;
      this.monitoring = (async () => {
        for (const instance of getInstances()) {
          if (this.stopping) break;
          if (!this.isApplying(instance)) {
            await this.quota.refreshInstanceUsage(instance);
            if (!this.isApplying(instance) && this.hasPendingRecovery(instance))
              instance.info.storageQuota = {
                ...instance.info.storageQuota,
                state: "error",
                error: $t("TXT_CODE_QUOTA_RECOVERY_REQUIRED")
              };
          }
        }
      })()
        .catch((error) => logger.error("XFS usage refresh failed:", error))
        .finally(() => {
          this.monitoring = undefined;
        });
    };
    this.timer = setInterval(refresh, 30000);
    refresh();
  }

  public async wait(instance: Instance) {
    await this.pending.get(instance.instanceUuid);
  }

  public async check(
    instance: Instance,
    patch: Partial<IGlobalInstanceConfig>,
    instances: Instance[]
  ) {
    const config = this.nextConfig(instance, patch);
    const shadow = Object.assign(Object.create(instance), { config });
    const workspace = this.quota.resolveDockerDiskWorkspace(shadow);
    const mount = await this.quota.inspectWorkspace(
      workspace,
      `mcsm_${instance.instanceUuid.replace(/[^a-zA-Z0-9]/g, "")}`,
      true
    );
    await this.quota.checkStoragePool(shadow, instances);
    return {
      available: true,
      workspace,
      mountPoint: mount.mountPoint,
      ...this.quota.validateConfig(config.docker)
    };
  }

  public async dispose() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.quota.dispose();
    await Promise.all([...this.pending.values(), this.monitoring]);
    this.pending.clear();
  }
}

export default new StorageQuotaOperationService();
