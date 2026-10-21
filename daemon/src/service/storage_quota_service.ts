import fs from "fs-extra";
import { toText } from "mcsmanager-common";
import { execFile } from "node:child_process";
import { open, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import * as lockfile from "proper-lockfile";
import StorageSubsystem from "../common/system_storage";
import { globalConfiguration } from "../entity/config";
import type Instance from "../entity/instance/instance";
import { $t } from "../i18n";
import logger from "./log";
import {
  GIB,
  getStorageQuotaLimits,
  parseXfsQuotaReport,
  pathsOverlap,
  resolveDockerHostWorkspacePath,
  normalizeStoragePools
} from "./storage_quota_utils";

const execFilePromise = promisify(execFile);

const PROJECTS_PATH = "/etc/projects";
const PROJID_PATH = "/etc/projid";
const PROJECT_TRANSACTION_PATH = "/etc/.mcsm-storage-quota-transaction.json";
const MIN_PROJECT_ID = 200000;
const COMMAND_TIMEOUT_MS = 10000;
const QUOTA_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const QUOTA_LOCK_PATH =
  process.env.MCSM_STORAGE_QUOTA_LOCK_PATH || path.join(os.tmpdir(), "mcsm-storage-quota");
const COMMAND_ENV = {
  ...process.env,
  LC_ALL: "C",
  LANG: "C",
  LANGUAGE: "C"
};

interface IXfsMountInfo {
  mountPoint: string;
  fstype: string;
  options: string[];
}

interface IProjectFiles {
  projectsText: string;
  projidText: string;
  projects: Map<number, string>;
  projids: Map<string, number>;
}

interface IProjectFileTransaction {
  version: 1;
  previousProjectsText: string;
  previousProjidText: string;
  nextProjectsText: string;
  nextProjidText: string;
}

async function runFile(
  command: string,
  args: string[] = [],
  timeout = COMMAND_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFilePromise(command, args, {
    timeout,
    signal,
    env: COMMAND_ENV
  });
  return { stdout: String(stdout || ""), stderr: String(stderr || "") };
}

function getErrorText(error: any) {
  return `${error?.stderr || ""}\n${error?.stdout || ""}\n${error?.message || ""}`;
}

function isPermissionError(error: any) {
  const errorText = getErrorText(error).toLowerCase();
  return (
    error?.code === "EACCES" ||
    error?.code === "EPERM" ||
    errorText.includes("permission denied") ||
    errorText.includes("operation not permitted") ||
    errorText.includes("not permitted") ||
    errorText.includes("不允许") ||
    errorText.includes("权限")
  );
}

function assertManagedProjectFile(
  filePath: string,
  managedPaths = [PROJECTS_PATH, PROJID_PATH, PROJECT_TRANSACTION_PATH]
) {
  if (!managedPaths.includes(filePath)) {
    throw new Error(`Refusing to access unmanaged quota file: ${filePath}`);
  }
}

async function readProjectFile(filePath: string, managedPaths?: string[]) {
  assertManagedProjectFile(filePath, managedPaths);
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return "";
    if (!isPermissionError(error)) throw error;
    throw new Error(
      $t("TXT_CODE_storage_quota_sudo_required", { error: getErrorText(error).trim() })
    );
  }
}

async function atomicWriteProjectFile(filePath: string, content: string, managedPaths?: string[]) {
  assertManagedProjectFile(filePath, managedPaths);
  const defaultMode = filePath === (managedPaths?.[2] ?? PROJECT_TRANSACTION_PATH) ? 0o600 : 0o644;
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.mcsm-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`
  );
  let currentStat: Awaited<ReturnType<typeof fs.stat>> | undefined;
  try {
    currentStat = await fs.stat(filePath);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }

  let handle;
  try {
    handle = await open(temporaryPath, "wx", currentStat?.mode ?? defaultMode);
    await handle.writeFile(content, "utf-8");
    await handle.sync();
    await handle.chmod(currentStat?.mode ?? defaultMode);
    if (currentStat && typeof process.getuid === "function" && process.getuid() === 0) {
      await handle.chown(currentStat.uid, currentStat.gid);
    }
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, filePath);
    const directoryHandle = await open(directory, "r");
    try {
      // The file has already been atomically replaced. A directory fsync failure must not
      // be reported as a failed replacement, otherwise the caller could roll back only
      // the companion file and create an inconsistent pair.
      await directoryHandle.sync().catch(() => {});
    } finally {
      await directoryHandle.close();
    }
  } catch (error: any) {
    if (isPermissionError(error)) {
      throw new Error(
        $t("TXT_CODE_storage_quota_sudo_required", { error: getErrorText(error).trim() })
      );
    }
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.remove(temporaryPath).catch(() => {});
  }
}

export interface IStorageQuotaServiceOptions {
  projectsPath?: string;
  projidPath?: string;
  transactionPath?: string;
  lockPath?: string;
  runCommand?: typeof runFile;
}

export class StorageQuotaService {
  private readonly projectPaths: { projects: string; projid: string; transaction: string };
  private readonly managedPaths: string[];
  private readonly lockPath: string;
  private readonly runCommand: typeof runFile;
  private readonly commandController = new AbortController();
  private getInstances?: () => Instance[];

  constructor(options: IStorageQuotaServiceOptions = {}) {
    this.projectPaths = {
      projects: options.projectsPath || PROJECTS_PATH,
      projid: options.projidPath || PROJID_PATH,
      transaction: options.transactionPath || PROJECT_TRANSACTION_PATH
    };
    this.managedPaths = Object.values(this.projectPaths);
    this.lockPath = options.lockPath || QUOTA_LOCK_PATH;
    this.runCommand = options.runCommand || runFile;
  }

  #runFile(command: string, args: string[] = [], timeout = COMMAND_TIMEOUT_MS) {
    return this.runCommand(command, args, timeout, this.commandController.signal);
  }

  async #runPrivilegedFile(command: string, args: string[] = [], timeout = COMMAND_TIMEOUT_MS) {
    try {
      return await this.#runFile(command, args, timeout);
    } catch (error) {
      if (!isPermissionError(error)) throw error;
      throw new Error(
        $t("TXT_CODE_storage_quota_sudo_required", { error: getErrorText(error).trim() })
      );
    }
  }

  #atomicWriteProjectFile(filePath: string, content: string) {
    return atomicWriteProjectFile(filePath, content, this.managedPaths);
  }

  #readProjectFile(filePath: string) {
    return readProjectFile(filePath, this.managedPaths);
  }
  private quotaOperation = Promise.resolve();
  private reports = new Map<
    string,
    {
      updatedAt: number;
      enforced: boolean;
      blocks: ReturnType<typeof parseXfsQuotaReport>;
      inodes: ReturnType<typeof parseXfsQuotaReport>;
    }
  >();
  private reportRequests = new Map<string, Promise<void>>();

  public clearUsageCache() {
    this.reports.clear();
  }

  public dispose() {
    this.commandController.abort();
    this.clearUsageCache();
    this.reportRequests.clear();
    this.getInstances = undefined;
  }

  public setInstanceProvider(provider: () => Instance[]) {
    this.getInstances = provider;
  }

  public validateConfig(config: IGlobalInstanceDockerConfig) {
    try {
      return getStorageQuotaLimits(config);
    } catch (error) {
      throw new Error($t("TXT_CODE_QUOTA_INVALID_CONFIG"));
    }
  }

  public async inspectWorkspace(workspace: string, projectName?: string, allowMissing = false) {
    this.#assertSafeWorkspacePath(workspace);
    let existingPath = workspace;
    if (allowMissing) {
      while (!(await fs.pathExists(existingPath))) existingPath = path.dirname(existingPath);
    }
    const realExistingPath = await fs.realpath(existingPath);
    const realWorkspace = path.join(realExistingPath, path.relative(existingPath, workspace));
    const realStat = await fs.stat(realExistingPath);
    if (!realStat.isDirectory() || path.normalize(realWorkspace) !== path.normalize(workspace))
      throw new Error($t("TXT_CODE_QUOTA_UNSAFE_PATH"));
    const mount = await this.#getXfsProjectQuotaMount(realExistingPath);
    if (realWorkspace === mount.mountPoint) throw new Error($t("TXT_CODE_QUOTA_UNSAFE_PATH"));
    const projectFiles = await this.#readProjectFiles();
    const ownId = projectName ? projectFiles.projids.get(projectName) : undefined;
    for (const [id, registeredPath] of projectFiles.projects) {
      if (id === ownId) continue;
      let realRegisteredPath: string;
      try {
        realRegisteredPath = await fs.realpath(registeredPath);
      } catch (error: any) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      if (pathsOverlap(realWorkspace, realRegisteredPath))
        throw new Error($t("TXT_CODE_QUOTA_OVERLAPPING_PATH"));
    }
    await this.#assertXfsQuotaCommand();
    const { stdout } = await this.#runPrivilegedFile("xfs_quota", [
      "-x",
      "-c",
      "state -p",
      mount.mountPoint
    ]);
    if (!/Accounting:\s*ON/i.test(stdout) || !/Enforcement:\s*ON/i.test(stdout))
      throw new Error($t("TXT_CODE_QUOTA_ENFORCEMENT_OFF"));
    return mount;
  }

  async #refreshReport(mountPoint: string, force = false): Promise<void> {
    if (!force && Date.now() - (this.reports.get(mountPoint)?.updatedAt ?? 0) < 30000) return;
    const pending = this.reportRequests.get(mountPoint);
    if (pending) {
      await pending;
      if (force) return this.#refreshReport(mountPoint, true);
      return;
    }
    const request = (async () => {
      const [blocks, inodes, state] = await Promise.all([
        this.#runPrivilegedFile("xfs_quota", ["-x", "-c", "report -p -n -N -b", mountPoint]),
        this.#runPrivilegedFile("xfs_quota", ["-x", "-c", "report -p -n -N -i", mountPoint]),
        this.#runPrivilegedFile("xfs_quota", ["-x", "-c", "state -p", mountPoint])
      ]);
      if (this.commandController.signal.aborted) throw new Error($t("TXT_CODE_QUOTA_BUSY"));
      for (const [key, report] of this.reports) {
        if (Date.now() - report.updatedAt > 5 * 60 * 1000) this.reports.delete(key);
      }
      if (this.reports.size >= 128) this.reports.delete(this.reports.keys().next().value!);
      this.reports.set(mountPoint, {
        updatedAt: Date.now(),
        enforced: /Accounting:\s*ON/i.test(state.stdout) && /Enforcement:\s*ON/i.test(state.stdout),
        blocks: parseXfsQuotaReport(blocks.stdout),
        inodes: parseXfsQuotaReport(inodes.stdout, 1)
      });
    })();
    this.reportRequests.set(mountPoint, request);
    try {
      await request;
    } finally {
      this.reportRequests.delete(mountPoint);
    }
  }

  public async readUsage(instance: Instance, force = false): Promise<IStorageQuotaInfo> {
    const limits = this.validateConfig(instance.config.docker);
    const workspace = this.resolveDockerDiskWorkspace(instance);
    const mount = await this.#getXfsProjectQuotaMount(workspace);
    await this.#refreshReport(mount.mountPoint, force);
    const projectId = Number(instance.config.docker.storageQuotaProjectId);
    const report = this.reports.get(mount.mountPoint)!;
    const blocks = report.blocks.get(projectId);
    const inodes = report.inodes.get(projectId);
    if (!blocks || !inodes) throw new Error($t("TXT_CODE_QUOTA_NOT_APPLIED"));
    const matches = blocks.hard === limits.hardLimitBytes && inodes.hard === limits.inodeLimit;
    return {
      state: matches && report.enforced ? "ready" : "error",
      updatedAt: report.updatedAt,
      error: !report.enforced
        ? $t("TXT_CODE_QUOTA_ENFORCEMENT_OFF")
        : !matches
        ? $t("TXT_CODE_QUOTA_VERIFY_FAILED")
        : undefined,
      usedBytes: blocks.used,
      allocatedBytes: limits.allocatedBytes,
      hardLimitBytes: blocks.hard,
      usedInodes: inodes.used,
      hardLimitInodes: inodes.hard,
      warning:
        blocks.used >= (limits.allocatedBytes * limits.warningPercent) / 100 ||
        (inodes.hard > 0 && inodes.used >= (inodes.hard * limits.warningPercent) / 100)
    };
  }

  public async refreshInstanceUsage(instance: Instance) {
    if (
      !instance.config.docker.enableHardStorageQuota ||
      instance.info.storageQuota?.state === "applying"
    )
      return;
    const previousState = instance.info.storageQuota;
    try {
      const previousWarning = previousState?.warning;
      const quota = await this.readUsage(instance);
      if (instance.info.storageQuota !== previousState) return;
      instance.info.storageUsage = quota.usedBytes;
      instance.info.storageLimit = quota.allocatedBytes;
      instance.info.storageQuota =
        previousState?.state === "error"
          ? { ...quota, state: "error", error: previousState.error }
          : quota;
      if (quota.warning && !previousWarning)
        instance.println("WARNING", $t("TXT_CODE_QUOTA_WARNING"));
    } catch (error: any) {
      if (instance.info.storageQuota !== previousState) return;
      logger.error("Failed to read XFS instance usage:", instance.instanceUuid, error);
      instance.info.storageQuota = {
        ...instance.info.storageQuota,
        state: "unknown",
        error: error.message
      };
    }
  }

  #resolveStoragePoolWorkspace(pool: IStoragePoolConfig) {
    return resolveDockerHostWorkspacePath(
      pool.path,
      this.#getDefaultInstanceDir(),
      toText(process.env.MCSM_DOCKER_WORKSPACE_PATH),
      { allowRoot: true }
    );
  }

  async #inspectStoragePoolDirectory(pool: IStoragePoolConfig) {
    const workspace = this.#resolveStoragePoolWorkspace(pool);
    for (const directory of new Set([pool.path, workspace])) {
      if ((await fs.realpath(directory)) !== directory || !(await fs.stat(directory)).isDirectory())
        throw new Error($t("TXT_CODE_QUOTA_UNSAFE_PATH"));
    }
    return workspace;
  }

  public async listStoragePools(
    instances: Instance[],
    exclude?: Instance
  ): Promise<IStoragePoolInfo[]> {
    const result: IStoragePoolInfo[] = [];
    const files = (globalConfiguration.config.storagePools || []).length
      ? await this.#readProjectFiles()
      : undefined;
    for (const pool of globalConfiguration.config.storagePools || []) {
      try {
        const workspace = await this.#inspectStoragePoolDirectory(pool);
        const mount = await this.#getXfsProjectQuotaMount(workspace);
        const stats = await statfs(workspace);
        await this.#refreshReport(mount.mountPoint);
        const report = this.reports.get(mount.mountPoint)!;
        if (!report.enforced) throw new Error($t("TXT_CODE_QUOTA_ENFORCEMENT_OFF"));
        let allocatedBytes = Array.from(report.blocks.values()).reduce(
          (sum, record) => sum + record.hard,
          0
        );
        for (const instance of instances) {
          if (!instance.config.docker.enableHardStorageQuota) continue;
          const workspace = this.resolveDockerDiskWorkspace(instance);
          let existingPath = workspace;
          while (!(await fs.pathExists(existingPath))) existingPath = path.dirname(existingPath);
          const instanceMount = await this.#getMountInfo(existingPath);
          if (instanceMount.mountPoint !== mount.mountPoint) continue;
          const id = Number(instance.config.docker.storageQuotaProjectId);
          const ownsProject =
            files?.projids.get(this.#getProjectName(instance)) === id &&
            files.projects.get(id) === workspace;
          const recorded = ownsProject ? report.blocks.get(id)?.hard ?? 0 : 0;
          allocatedBytes -= recorded;
          if (instance.instanceUuid !== exclude?.instanceUuid)
            allocatedBytes += this.validateConfig(instance.config.docker).hardLimitBytes;
        }
        const totalBytes = stats.blocks * stats.bsize;
        const availableBytes = stats.bavail * stats.bsize;
        const reserveBytes = pool.reserveGiB * GIB;
        result.push({
          ...pool,
          totalBytes,
          availableBytes,
          allocatedBytes,
          allocatableBytes: Math.max(
            0,
            Math.min(totalBytes - allocatedBytes - reserveBytes, availableBytes - reserveBytes)
          )
        });
      } catch (error: any) {
        logger.error("Failed to inspect storage pool:", pool.id, error);
        result.push({ ...pool, error: error.message });
      }
    }
    return result;
  }

  public async validateStoragePools(value: unknown, instances: Instance[]) {
    let pools: IStoragePoolConfig[];
    try {
      pools = normalizeStoragePools(value);
    } catch {
      throw new Error($t("TXT_CODE_QUOTA_INVALID_POOLS"));
    }
    for (const current of globalConfiguration.config.storagePools || []) {
      if (
        instances.some((instance) => instance.config.docker.storagePoolId === current.id) &&
        !pools.some((pool) => pool.id === current.id && pool.path === current.path)
      )
        throw new Error($t("TXT_CODE_QUOTA_POOL_IN_USE"));
    }
    const mounts = new Set<string>();
    for (const pool of pools) {
      const workspace = await this.#inspectStoragePoolDirectory(pool);
      const mount = await this.#getXfsProjectQuotaMount(workspace);
      if (mounts.has(mount.mountPoint)) throw new Error($t("TXT_CODE_QUOTA_INVALID_POOLS"));
      mounts.add(mount.mountPoint);
      const { stdout } = await this.#runPrivilegedFile("xfs_quota", [
        "-x",
        "-c",
        "state -p",
        mount.mountPoint
      ]);
      if (!/Accounting:\s*ON/i.test(stdout) || !/Enforcement:\s*ON/i.test(stdout))
        throw new Error($t("TXT_CODE_QUOTA_ENFORCEMENT_OFF"));
    }
    return pools;
  }

  public resolvePoolDirectory(poolId: string, instanceUuid: string) {
    if (!poolId && /^[a-zA-Z0-9_-]{1,128}$/.test(instanceUuid))
      return path.join(this.#getDefaultInstanceDir(), instanceUuid);
    const pool = (globalConfiguration.config.storagePools || []).find((item) => item.id === poolId);
    if (!pool || !/^[a-zA-Z0-9_-]{1,128}$/.test(instanceUuid))
      throw new Error($t("TXT_CODE_QUOTA_POOL_NOT_FOUND"));
    return path.join(pool.path, instanceUuid);
  }

  public async checkStoragePool(instance: Instance, instances: Instance[]) {
    const poolId = instance.config.docker.storagePoolId;
    if (!poolId) return;
    const allocationInstances = instances.some(
      (item) => item.instanceUuid === instance.instanceUuid
    )
      ? instances
      : [...instances, instance];
    const pool = (await this.listStoragePools(allocationInstances, instance)).find(
      (item) => item.id === poolId
    );
    if (!pool || pool.error) throw new Error(pool?.error || $t("TXT_CODE_QUOTA_POOL_NOT_FOUND"));
    const workspace = this.resolveDockerDiskWorkspace(instance);
    const relative = path.relative(this.#resolveStoragePoolWorkspace(pool), workspace);
    if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative))
      throw new Error($t("TXT_CODE_QUOTA_POOL_PATH"));
    const limits = this.validateConfig(instance.config.docker);
    let ownUsed = 0;
    const files = await this.#readProjectFiles();
    if (files.projects.get(Number(instance.config.docker.storageQuotaProjectId)) === workspace)
      ownUsed = (await this.readUsage(instance, true)).usedBytes ?? 0;
    const reserveBytes = pool.reserveGiB * GIB;
    if (
      limits.hardLimitBytes > pool.totalBytes! - pool.allocatedBytes! - reserveBytes ||
      Math.max(0, limits.hardLimitBytes - ownUsed) > pool.availableBytes! - reserveBytes
    )
      throw new Error($t("TXT_CODE_QUOTA_POOL_FULL"));
  }

  public resolveDockerLocalWorkspace(instance: Instance) {
    return instance.absoluteCwdPath();
  }

  public resolveDockerHostWorkspace(instance: Instance, defaultInstanceDir: string) {
    return resolveDockerHostWorkspacePath(
      instance.absoluteCwdPath(),
      defaultInstanceDir,
      toText(process.env.MCSM_DOCKER_WORKSPACE_PATH)
    );
  }

  public resolveDockerDiskWorkspace(instance: Instance) {
    if (instance.config.processType !== "docker") return instance.absoluteCwdPath();
    return this.resolveDockerHostWorkspace(instance, this.#getDefaultInstanceDir());
  }

  public async recoverPendingProjectFileTransaction() {
    if (os.platform() !== "linux") return;
    await this.#withQuotaOperationLock(async () => {});
  }

  public async ensureDockerHardQuota(
    instance: Instance,
    workspace: string,
    maxSpaceGb: number,
    options: { reinitialize?: boolean; restore?: boolean } = {}
  ) {
    if (!Number.isFinite(maxSpaceGb) || maxSpaceGb <= 0) return;
    return this.#withQuotaOperationLock(async () => {
      // Recovery reinstates an existing allocation even if its pool is now full.
      if (!options.restore && instance.config.docker.storagePoolId) {
        this.clearUsageCache();
        await this.checkStoragePool(instance, this.getInstances?.() || [instance]);
      }
      await this.#ensureDockerHardQuota(instance, workspace, maxSpaceGb, options);
    });
  }

  public async clearDockerHardQuotaIfManaged(instance: Instance, workspace: string) {
    return this.#withQuotaOperationLock(async () => {
      await this.#clearDockerHardQuotaIfManaged(instance, workspace, false);
    });
  }

  public async deleteDockerHardQuotaIfManaged(instance: Instance, workspace: string) {
    return this.#withQuotaOperationLock(async () => {
      await this.#clearDockerHardQuotaIfManaged(instance, workspace, true);
    });
  }

  async #ensureDockerHardQuota(
    instance: Instance,
    workspace: string,
    maxSpaceGb: number,
    options: { reinitialize?: boolean; restore?: boolean }
  ) {
    this.#assertSafeWorkspacePath(workspace);
    await this.#assertWorkspaceVisible(workspace);
    const mountInfo = await this.inspectWorkspace(workspace, this.#getProjectName(instance));
    const limits = this.validateConfig({ ...instance.config.docker, maxSpace: maxSpaceGb });

    const projectName = this.#getProjectName(instance);
    const projectFiles = await this.#readProjectFiles();
    await this.#refreshReport(mountInfo.mountPoint, true);
    const projectId = this.#resolveProjectId(instance, workspace, projectName, projectFiles);
    const registered =
      !options.reinitialize &&
      projectFiles.projids.get(projectName) === projectId &&
      projectFiles.projects.get(projectId) === workspace &&
      instance.config.docker.storageQuotaProjectId === projectId;
    const initialized =
      registered &&
      (await this.#isProjectRootInitialized(projectName, workspace, mountInfo.mountPoint));

    await this.#writeProjectFiles(projectFiles, projectName, projectId, workspace);
    try {
      if (!initialized) {
        // A partial tree repair must never leave a persisted claim that the quota is ready.
        if (instance.config.docker.storageQuotaProjectId != null) {
          instance.config.docker.storageQuotaProjectId = undefined;
          StorageSubsystem.store("InstanceConfig", instance.instanceUuid, instance.config);
        }
        await this.#runPrivilegedFile(
          "xfs_quota",
          ["-x", "-c", `project -s ${projectName}`, mountInfo.mountPoint],
          QUOTA_COMMAND_TIMEOUT_MS
        );
        if (!(await this.#isProjectRootInitialized(projectName, workspace, mountInfo.mountPoint)))
          throw new Error($t("TXT_CODE_QUOTA_VERIFY_FAILED"));
      }
      await this.#refreshReport(mountInfo.mountPoint, true);
      const existingUsage = this.reports.get(mountInfo.mountPoint)?.blocks.get(projectId);
      const existingInodes = this.reports.get(mountInfo.mountPoint)?.inodes.get(projectId);
      // Buffered writes must not prevent recovery from restoring the previous hard limit.
      if (
        !options.restore &&
        ((existingUsage && existingUsage.used > limits.allocatedBytes) ||
          (limits.inodeLimit && existingInodes && existingInodes.used > limits.inodeLimit))
      )
        throw new Error($t("TXT_CODE_QUOTA_SHRINK_BELOW_USAGE"));
      await this.#runPrivilegedFile(
        "xfs_quota",
        [
          "-x",
          "-c",
          `limit -p bsoft=0 bhard=${limits.hardLimitBytes / 1024}k isoft=0 ihard=${
            limits.inodeLimit
          } ${projectName}`,
          mountInfo.mountPoint
        ],
        QUOTA_COMMAND_TIMEOUT_MS
      );
      await this.#refreshReport(mountInfo.mountPoint, true);
      const applied = this.reports.get(mountInfo.mountPoint);
      if (
        !applied?.enforced ||
        applied?.blocks.get(projectId)?.hard !== limits.hardLimitBytes ||
        applied?.inodes.get(projectId)?.hard !== limits.inodeLimit
      )
        throw new Error($t("TXT_CODE_QUOTA_VERIFY_FAILED"));
    } catch (error: any) {
      throw new Error($t("TXT_CODE_storage_quota_apply_failed", { error: error.message }));
    }

    if (instance.config.docker.storageQuotaProjectId !== projectId) {
      instance.config.docker.storageQuotaProjectId = projectId;
      StorageSubsystem.store("InstanceConfig", instance.instanceUuid, instance.config);
    }
  }

  async #clearDockerHardQuotaIfManaged(
    instance: Instance,
    workspace: string,
    removeProject: boolean
  ) {
    this.#assertSafeWorkspacePath(workspace);
    const projectName = this.#getProjectName(instance);
    const projectFiles = await this.#readProjectFiles();
    const registeredProjectId = projectFiles.projids.get(projectName);
    const configuredProjectId =
      Number(instance.config.docker.storageQuotaProjectId || 0) || undefined;

    if (registeredProjectId && configuredProjectId && registeredProjectId !== configuredProjectId) {
      throw new Error(
        $t("TXT_CODE_storage_quota_project_id_conflict", {
          id: configuredProjectId,
          name: projectName
        })
      );
    }

    if (!registeredProjectId) {
      if (!configuredProjectId) return;
      const conflictingName = Array.from(projectFiles.projids.entries()).find(
        ([name, id]) => id === configuredProjectId && name !== projectName
      )?.[0];
      const configuredPath = projectFiles.projects.get(configuredProjectId);
      if (conflictingName || configuredPath) {
        throw new Error(
          $t("TXT_CODE_storage_quota_project_id_conflict", {
            id: configuredProjectId,
            name: conflictingName || configuredPath
          })
        );
      }
      instance.config.docker.storageQuotaProjectId = undefined;
      StorageSubsystem.store("InstanceConfig", instance.instanceUuid, instance.config);
      return;
    }

    const projectId = registeredProjectId;
    const conflictingName = Array.from(projectFiles.projids.entries()).find(
      ([name, id]) => id === projectId && name !== projectName
    )?.[0];
    if (conflictingName) {
      throw new Error(
        $t("TXT_CODE_storage_quota_project_id_conflict", {
          id: projectId,
          name: conflictingName
        })
      );
    }

    const projectWorkspace = projectFiles.projects.get(projectId);
    if (!projectWorkspace) {
      throw new Error(
        $t("TXT_CODE_storage_quota_project_path_conflict", {
          id: projectId,
          path: "(missing)"
        })
      );
    }
    this.#assertSafeWorkspacePath(projectWorkspace);
    await this.#assertWorkspaceVisible(projectWorkspace);
    const mountInfo = await this.#getXfsProjectQuotaMount(projectWorkspace);
    await this.#assertXfsQuotaCommand();
    await this.#runPrivilegedFile(
      "xfs_quota",
      ["-x", "-c", `limit -p bsoft=0 bhard=0 isoft=0 ihard=0 ${projectName}`, mountInfo.mountPoint],
      QUOTA_COMMAND_TIMEOUT_MS
    );
    this.clearUsageCache();

    if (removeProject) {
      await this.#runPrivilegedFile(
        "xfs_quota",
        ["-x", "-c", `project -C ${projectName}`, mountInfo.mountPoint],
        QUOTA_COMMAND_TIMEOUT_MS
      );
      await this.#removeProjectFiles(projectFiles, projectName, projectId);
      instance.config.docker.storageQuotaProjectId = undefined;
      StorageSubsystem.store("InstanceConfig", instance.instanceUuid, instance.config);
    }
  }

  async #withQuotaOperationLock<T>(operation: () => Promise<T>) {
    const previous = this.quotaOperation;
    let release!: () => void;
    this.quotaOperation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    let releaseFileLock: (() => Promise<void>) | undefined;
    try {
      await this.#ensureSafeLockFile();
      releaseFileLock = await lockfile.lock(this.lockPath, {
        realpath: false,
        stale: QUOTA_COMMAND_TIMEOUT_MS * 2,
        retries: {
          retries: 30,
          factor: 1.2,
          minTimeout: 100,
          maxTimeout: 1000
        }
      });
      await this.#recoverProjectFileTransaction();
      return await operation();
    } finally {
      try {
        if (releaseFileLock) await releaseFileLock();
      } finally {
        release();
      }
    }
  }

  async #ensureSafeLockFile() {
    if (!path.isAbsolute(this.lockPath) || /[\0\r\n]/.test(this.lockPath)) {
      throw new Error(`Invalid storage quota lock path: ${JSON.stringify(this.lockPath)}`);
    }
    let handle;
    try {
      handle = await open(this.lockPath, "wx", 0o600);
      await handle.sync();
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    } finally {
      if (handle) await handle.close();
    }

    const lockStat = await fs.lstat(this.lockPath);
    if (!lockStat.isFile() || lockStat.isSymbolicLink()) {
      throw new Error(`Storage quota lock path must be a regular file: ${this.lockPath}`);
    }
    if ((lockStat.mode & 0o022) !== 0) {
      throw new Error(`Storage quota lock file must not be group/world writable: ${this.lockPath}`);
    }
    if (typeof process.getuid === "function" && lockStat.uid !== process.getuid()) {
      throw new Error(`Storage quota lock file is owned by another user: ${this.lockPath}`);
    }
  }

  async #readProjectFileTransaction(): Promise<IProjectFileTransaction | undefined> {
    let transactionStat;
    try {
      transactionStat = await fs.lstat(this.projectPaths.transaction);
    } catch (error: any) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
    if (!transactionStat.isFile() || transactionStat.isSymbolicLink()) {
      throw new Error(`Invalid quota transaction journal: ${this.projectPaths.transaction}`);
    }
    if (transactionStat.size > 8 * 1024 * 1024) {
      throw new Error(`Quota transaction journal is unexpectedly large: ${transactionStat.size}`);
    }

    const value = JSON.parse(await this.#readProjectFile(this.projectPaths.transaction));
    if (
      value?.version !== 1 ||
      typeof value.previousProjectsText !== "string" ||
      typeof value.previousProjidText !== "string" ||
      typeof value.nextProjectsText !== "string" ||
      typeof value.nextProjidText !== "string"
    ) {
      throw new Error(`Invalid quota transaction journal: ${this.projectPaths.transaction}`);
    }
    return value;
  }

  async #removeProjectFileTransaction() {
    assertManagedProjectFile(this.projectPaths.transaction, this.managedPaths);
    await fs.remove(this.projectPaths.transaction);
    const directoryHandle = await open(path.dirname(this.projectPaths.transaction), "r");
    try {
      await directoryHandle.sync().catch(() => {});
    } finally {
      await directoryHandle.close();
    }
  }

  async #recoverProjectFileTransaction() {
    const transaction = await this.#readProjectFileTransaction();
    if (!transaction) return;
    await this.#atomicWriteProjectFile(this.projectPaths.projid, transaction.nextProjidText);
    await this.#atomicWriteProjectFile(this.projectPaths.projects, transaction.nextProjectsText);
    await this.#removeProjectFileTransaction();
  }

  async #isProjectRootInitialized(projectName: string, workspace: string, mountPoint: string) {
    const result = await this.#runPrivilegedFile("xfs_quota", [
      "-x",
      "-c",
      `project -c -d 0 ${projectName}`,
      mountPoint
    ]);
    const expected = [
      `Checking project ${projectName} (path ${workspace})...`,
      `Processed 1 (${this.projectPaths.projects} and cmdline) paths for project ${projectName} with recursion depth limited (0).`
    ];
    const lines = result.stdout.trim().split(/\r?\n/);
    return (
      !result.stderr.trim() &&
      lines.length === expected.length &&
      lines.every((line, index) => line === expected[index])
    );
  }

  async #getXfsProjectQuotaMount(workspace: string): Promise<IXfsMountInfo> {
    const mount = await this.#getMountInfo(workspace);
    if (mount.fstype !== "xfs")
      throw new Error($t("TXT_CODE_storage_quota_requires_xfs", { path: workspace }));
    if (!mount.options.includes("prjquota") && !mount.options.includes("pquota"))
      throw new Error($t("TXT_CODE_storage_quota_requires_prjquota", { path: workspace }));
    return mount;
  }

  async #getMountInfo(workspace: string): Promise<IXfsMountInfo> {
    if (os.platform() !== "linux") {
      throw new Error($t("TXT_CODE_storage_quota_linux_only"));
    }
    try {
      const { stdout } = await this.#runFile("findmnt", [
        "--target",
        workspace,
        "--json",
        "--output",
        "TARGET,FSTYPE,OPTIONS"
      ]);
      const data = JSON.parse(String(stdout));
      const filesystem = data?.filesystems?.[0];
      if (!filesystem?.target) {
        throw new Error($t("TXT_CODE_storage_quota_mount_not_found", { path: workspace }));
      }
      const fstype = String(filesystem.fstype || "").toLowerCase();
      const options = String(filesystem.options || "")
        .toLowerCase()
        .split(",")
        .filter(Boolean);
      return {
        mountPoint: String(filesystem.target),
        fstype,
        options
      };
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        throw new Error($t("TXT_CODE_storage_quota_findmnt_missing"));
      }
      throw error;
    }
  }

  async #assertXfsQuotaCommand() {
    try {
      await this.#runFile("xfs_quota", ["-V"]);
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        throw new Error($t("TXT_CODE_storage_quota_xfs_quota_missing"));
      }
      throw error;
    }
  }

  async #assertWorkspaceVisible(workspace: string) {
    if (!(await fs.pathExists(workspace))) {
      throw new Error(
        $t("TXT_CODE_storage_quota_workspace_not_visible", {
          path: workspace
        })
      );
    }
  }

  #getProjectName(instance: Instance) {
    return `mcsm_${instance.instanceUuid.replace(/[^a-zA-Z0-9]/g, "")}`;
  }

  #assertSafeWorkspacePath(workspace: string) {
    if (
      !path.isAbsolute(workspace) ||
      /[\0\r\n:]/.test(workspace) ||
      path.normalize(workspace) === path.parse(workspace).root
    ) {
      throw new Error(`Invalid hard quota workspace path: ${JSON.stringify(workspace)}`);
    }
  }

  #getDefaultInstanceDir() {
    return path.normalize(
      globalConfiguration.config.defaultInstancePath ||
        path.join(process.cwd(), "data/InstanceData")
    );
  }

  async #readProjectFiles(): Promise<IProjectFiles> {
    const [projectsText, projidText] = await Promise.all([
      this.#readTextFile(this.projectPaths.projects),
      this.#readTextFile(this.projectPaths.projid)
    ]);
    return {
      projectsText,
      projidText,
      projects: this.#parseProjects(projectsText),
      projids: this.#parseProjids(projidText)
    };
  }

  async #readTextFile(filePath: string) {
    return await this.#readProjectFile(filePath);
  }

  #parseProjects(text: string) {
    const projects = new Map<number, string>();
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf(":");
      if (index === -1) continue;
      const id = Number(trimmed.slice(0, index));
      const projectPath = trimmed.slice(index + 1);
      if (Number.isInteger(id) && id > 0) projects.set(id, path.normalize(projectPath));
    }
    return projects;
  }

  #parseProjids(text: string) {
    const projids = new Map<string, number>();
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf(":");
      if (index === -1) continue;
      const name = trimmed.slice(0, index);
      const id = Number(trimmed.slice(index + 1));
      if (name && Number.isInteger(id) && id > 0) projids.set(name, id);
    }
    return projids;
  }

  #resolveProjectId(
    instance: Instance,
    workspace: string,
    projectName: string,
    projectFiles: IProjectFiles
  ) {
    const normalizedWorkspace = path.normalize(workspace);
    const existingNameId = projectFiles.projids.get(projectName);
    const configuredId = Number(instance.config.docker.storageQuotaProjectId || 0);
    const existingPathId = Array.from(projectFiles.projects.entries()).find(
      ([, projectPath]) => path.normalize(projectPath) === normalizedWorkspace
    )?.[0];
    const projectId =
      existingNameId || configuredId || existingPathId || this.#allocateProjectId(projectFiles);

    const conflictingName = Array.from(projectFiles.projids.entries()).find(
      ([name, id]) => id === projectId && name !== projectName
    )?.[0];
    if (conflictingName) {
      throw new Error(
        $t("TXT_CODE_storage_quota_project_id_conflict", {
          id: projectId,
          name: conflictingName
        })
      );
    }

    const conflictingPath = projectFiles.projects.get(projectId);
    if (conflictingPath && path.normalize(conflictingPath) !== normalizedWorkspace) {
      throw new Error(
        $t("TXT_CODE_storage_quota_project_path_conflict", {
          id: projectId,
          path: conflictingPath
        })
      );
    }

    if (existingPathId && existingPathId !== projectId) {
      throw new Error(
        $t("TXT_CODE_storage_quota_workspace_conflict", {
          path: normalizedWorkspace,
          id: existingPathId
        })
      );
    }

    return projectId;
  }

  #allocateProjectId(projectFiles: IProjectFiles) {
    const usedIds = new Set<number>([
      ...Array.from(projectFiles.projects.keys()),
      ...Array.from(projectFiles.projids.values())
    ]);
    for (const report of this.reports.values()) {
      for (const records of [report.blocks, report.inodes]) {
        for (const [id, usage] of records) {
          if (usage.used || usage.soft || usage.hard) usedIds.add(id);
        }
      }
    }
    let id = MIN_PROJECT_ID;
    while (usedIds.has(id)) id++;
    if (id > 0xffffffff) throw new Error($t("TXT_CODE_QUOTA_INVALID_CONFIG"));
    return id;
  }

  async #writeProjectFiles(
    projectFiles: IProjectFiles,
    projectName: string,
    projectId: number,
    workspace: string
  ) {
    this.#assertSafeWorkspacePath(workspace);
    const nextProjidText = this.#upsertLine(
      projectFiles.projidText,
      `${projectName}:${projectId}`,
      (line) => {
        const index = line.indexOf(":");
        return index !== -1 && line.slice(0, index) === projectName;
      }
    );
    const nextProjectsText = this.#upsertLine(
      projectFiles.projectsText,
      `${projectId}:${path.normalize(workspace)}`,
      (line) => {
        const index = line.indexOf(":");
        return index !== -1 && Number(line.slice(0, index)) === projectId;
      }
    );
    try {
      await this.#commitProjectFiles(projectFiles, nextProjectsText, nextProjidText);
    } catch (error: any) {
      throw new Error(
        $t("TXT_CODE_storage_quota_project_file_write_failed", { error: error.message })
      );
    }
  }

  async #removeProjectFiles(projectFiles: IProjectFiles, projectName: string, projectId: number) {
    const removeLines = (text: string, shouldRemove: (line: string) => boolean) => {
      const lines = text.replace(/\r\n/g, "\n").split("\n");
      if (lines.length && lines[lines.length - 1] === "") lines.pop();
      const nextLines = lines.filter((line) => !shouldRemove(line.trim()));
      return nextLines.length ? `${nextLines.join("\n")}\n` : "";
    };

    const nextProjidText = removeLines(projectFiles.projidText, (line) => {
      const index = line.indexOf(":");
      return index !== -1 && line.slice(0, index) === projectName;
    });
    const nextProjectsText = removeLines(projectFiles.projectsText, (line) => {
      const index = line.indexOf(":");
      return index !== -1 && Number(line.slice(0, index)) === projectId;
    });
    try {
      await this.#commitProjectFiles(projectFiles, nextProjectsText, nextProjidText);
    } catch (error: any) {
      throw new Error(
        $t("TXT_CODE_storage_quota_project_file_write_failed", { error: error.message })
      );
    }
  }

  async #commitProjectFiles(
    projectFiles: IProjectFiles,
    nextProjectsText: string,
    nextProjidText: string
  ) {
    const transaction: IProjectFileTransaction = {
      version: 1,
      previousProjectsText: projectFiles.projectsText,
      previousProjidText: projectFiles.projidText,
      nextProjectsText,
      nextProjidText
    };
    await this.#atomicWriteProjectFile(
      this.projectPaths.transaction,
      `${JSON.stringify(transaction)}\n`
    );
    try {
      await this.#atomicWriteProjectFile(this.projectPaths.projid, nextProjidText);
      await this.#atomicWriteProjectFile(this.projectPaths.projects, nextProjectsText);
      await this.#removeProjectFileTransaction();
    } catch (error: any) {
      try {
        await this.#atomicWriteProjectFile(this.projectPaths.projid, projectFiles.projidText);
        await this.#atomicWriteProjectFile(this.projectPaths.projects, projectFiles.projectsText);
        await this.#removeProjectFileTransaction();
      } catch (rollbackError: any) {
        throw new Error(
          `${error.message}; failed to roll back quota files: ${rollbackError.message}`
        );
      }
      throw error;
    }
  }

  #upsertLine(text: string, newLine: string, shouldReplace: (line: string) => boolean) {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    let replaced = false;
    const nextLines: string[] = [];
    for (const line of lines) {
      if (shouldReplace(line.trim())) {
        if (!replaced) nextLines.push(newLine);
        replaced = true;
      } else {
        nextLines.push(line);
      }
    }
    if (!replaced) nextLines.push(newLine);
    return `${nextLines.join("\n")}\n`;
  }
}

export default new StorageQuotaService();
