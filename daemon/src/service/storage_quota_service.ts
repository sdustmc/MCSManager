import fs from "fs-extra";
import { toText } from "mcsmanager-common";
import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import * as lockfile from "proper-lockfile";
import StorageSubsystem from "../common/system_storage";
import { globalConfiguration } from "../entity/config";
import Instance from "../entity/instance/instance";
import { $t } from "../i18n";
import { resolveDockerHostWorkspacePath } from "./storage_quota_utils";

const execFilePromise = promisify(execFile);

const PROJECTS_PATH = "/etc/projects";
const PROJID_PATH = "/etc/projid";
const PROJECT_TRANSACTION_PATH = "/etc/.mcsm-storage-quota-transaction.json";
const MIN_PROJECT_ID = 200000;
const COMMAND_TIMEOUT_MS = 10000;
const QUOTA_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const QUOTA_LOCK_PATH =
  process.env.MCSM_STORAGE_QUOTA_LOCK_PATH || path.join(os.tmpdir(), "mcsm-storage-quota");
const HARD_QUOTA_HEADROOM_RATIO = 1.1;
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
  timeout = COMMAND_TIMEOUT_MS
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFilePromise(command, args, {
    timeout,
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

async function runPrivilegedFile(
  command: string,
  args: string[] = [],
  timeout = COMMAND_TIMEOUT_MS
) {
  try {
    return await runFile(command, args, timeout);
  } catch (error: any) {
    if (!isPermissionError(error)) throw error;
    throw new Error(
      $t("TXT_CODE_storage_quota_sudo_required", { error: getErrorText(error).trim() })
    );
  }
}

function assertManagedProjectFile(filePath: string) {
  if (
    filePath !== PROJECTS_PATH &&
    filePath !== PROJID_PATH &&
    filePath !== PROJECT_TRANSACTION_PATH
  ) {
    throw new Error(`Refusing to access unmanaged quota file: ${filePath}`);
  }
}

async function readProjectFile(filePath: string) {
  assertManagedProjectFile(filePath);
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

async function atomicWriteProjectFile(filePath: string, content: string) {
  assertManagedProjectFile(filePath);
  const defaultMode = filePath === PROJECT_TRANSACTION_PATH ? 0o600 : 0o644;
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

class StorageQuotaService {
  private quotaOperation = Promise.resolve();

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

  public async ensureDockerHardQuota(instance: Instance, workspace: string, maxSpaceGb: number) {
    if (!Number.isFinite(maxSpaceGb) || maxSpaceGb <= 0) return;
    return this.#withQuotaOperationLock(async () => {
      await this.#ensureDockerHardQuota(instance, workspace, maxSpaceGb);
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

  async #ensureDockerHardQuota(instance: Instance, workspace: string, maxSpaceGb: number) {
    this.#assertSafeWorkspacePath(workspace);
    await this.#assertWorkspaceVisible(workspace);
    const mountInfo = await this.#getXfsProjectQuotaMount(workspace);
    await this.#assertXfsQuotaCommand();

    const projectName = this.#getProjectName(instance);
    const projectFiles = await this.#readProjectFiles();
    const projectId = this.#resolveProjectId(instance, workspace, projectName, projectFiles);

    await this.#writeProjectFiles(projectFiles, projectName, projectId, workspace);
    try {
      await runPrivilegedFile(
        "xfs_quota",
        ["-x", "-c", `project -s ${projectName}`, mountInfo.mountPoint],
        QUOTA_COMMAND_TIMEOUT_MS
      );
      await runPrivilegedFile(
        "xfs_quota",
        [
          "-x",
          "-c",
          `limit -p bhard=${this.#toQuotaKiB(maxSpaceGb)} ${projectName}`,
          mountInfo.mountPoint
        ],
        QUOTA_COMMAND_TIMEOUT_MS
      );
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
    await runPrivilegedFile(
      "xfs_quota",
      ["-x", "-c", `limit -p bsoft=0 bhard=0 ${projectName}`, mountInfo.mountPoint],
      QUOTA_COMMAND_TIMEOUT_MS
    );

    if (removeProject) {
      await runPrivilegedFile(
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
      releaseFileLock = await lockfile.lock(QUOTA_LOCK_PATH, {
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
    if (!path.isAbsolute(QUOTA_LOCK_PATH) || /[\0\r\n]/.test(QUOTA_LOCK_PATH)) {
      throw new Error(`Invalid storage quota lock path: ${JSON.stringify(QUOTA_LOCK_PATH)}`);
    }
    let handle;
    try {
      handle = await open(QUOTA_LOCK_PATH, "wx", 0o600);
      await handle.sync();
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    } finally {
      if (handle) await handle.close();
    }

    const lockStat = await fs.lstat(QUOTA_LOCK_PATH);
    if (!lockStat.isFile() || lockStat.isSymbolicLink()) {
      throw new Error(`Storage quota lock path must be a regular file: ${QUOTA_LOCK_PATH}`);
    }
    if ((lockStat.mode & 0o022) !== 0) {
      throw new Error(
        `Storage quota lock file must not be group/world writable: ${QUOTA_LOCK_PATH}`
      );
    }
    if (typeof process.getuid === "function" && lockStat.uid !== process.getuid()) {
      throw new Error(`Storage quota lock file is owned by another user: ${QUOTA_LOCK_PATH}`);
    }
  }

  async #readProjectFileTransaction(): Promise<IProjectFileTransaction | undefined> {
    let transactionStat;
    try {
      transactionStat = await fs.lstat(PROJECT_TRANSACTION_PATH);
    } catch (error: any) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
    if (!transactionStat.isFile() || transactionStat.isSymbolicLink()) {
      throw new Error(`Invalid quota transaction journal: ${PROJECT_TRANSACTION_PATH}`);
    }
    if (transactionStat.size > 8 * 1024 * 1024) {
      throw new Error(`Quota transaction journal is unexpectedly large: ${transactionStat.size}`);
    }

    const value = JSON.parse(await readProjectFile(PROJECT_TRANSACTION_PATH));
    if (
      value?.version !== 1 ||
      typeof value.previousProjectsText !== "string" ||
      typeof value.previousProjidText !== "string" ||
      typeof value.nextProjectsText !== "string" ||
      typeof value.nextProjidText !== "string"
    ) {
      throw new Error(`Invalid quota transaction journal: ${PROJECT_TRANSACTION_PATH}`);
    }
    return value;
  }

  async #removeProjectFileTransaction() {
    assertManagedProjectFile(PROJECT_TRANSACTION_PATH);
    await fs.remove(PROJECT_TRANSACTION_PATH);
    const directoryHandle = await open(path.dirname(PROJECT_TRANSACTION_PATH), "r");
    try {
      await directoryHandle.sync().catch(() => {});
    } finally {
      await directoryHandle.close();
    }
  }

  async #recoverProjectFileTransaction() {
    const transaction = await this.#readProjectFileTransaction();
    if (!transaction) return;
    await atomicWriteProjectFile(PROJID_PATH, transaction.nextProjidText);
    await atomicWriteProjectFile(PROJECTS_PATH, transaction.nextProjectsText);
    await this.#removeProjectFileTransaction();
  }

  async #getXfsProjectQuotaMount(workspace: string): Promise<IXfsMountInfo> {
    if (os.platform() !== "linux") {
      throw new Error($t("TXT_CODE_storage_quota_linux_only"));
    }
    try {
      const { stdout } = await runFile("findmnt", [
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
      if (fstype !== "xfs") {
        throw new Error($t("TXT_CODE_storage_quota_requires_xfs", { path: workspace }));
      }
      if (!options.includes("prjquota") && !options.includes("pquota")) {
        throw new Error($t("TXT_CODE_storage_quota_requires_prjquota", { path: workspace }));
      }
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
      await runFile("xfs_quota", ["-V"]);
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
    if (!path.isAbsolute(workspace) || /[\0\r\n]/.test(workspace)) {
      throw new Error(`Invalid hard quota workspace path: ${JSON.stringify(workspace)}`);
    }
  }

  #toQuotaKiB(maxSpaceGb: number) {
    return `${Math.ceil(maxSpaceGb * HARD_QUOTA_HEADROOM_RATIO * 1024 * 1024)}k`;
  }

  #getDefaultInstanceDir() {
    return path.normalize(
      globalConfiguration.config.defaultInstancePath ||
        path.join(process.cwd(), "data/InstanceData")
    );
  }

  async #readProjectFiles(): Promise<IProjectFiles> {
    const [projectsText, projidText] = await Promise.all([
      this.#readTextFile(PROJECTS_PATH),
      this.#readTextFile(PROJID_PATH)
    ]);
    return {
      projectsText,
      projidText,
      projects: this.#parseProjects(projectsText),
      projids: this.#parseProjids(projidText)
    };
  }

  async #readTextFile(filePath: string) {
    return await readProjectFile(filePath);
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
    let id = MIN_PROJECT_ID;
    while (usedIds.has(id)) id++;
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
    await atomicWriteProjectFile(PROJECT_TRANSACTION_PATH, `${JSON.stringify(transaction)}\n`);
    try {
      await atomicWriteProjectFile(PROJID_PATH, nextProjidText);
      await atomicWriteProjectFile(PROJECTS_PATH, nextProjectsText);
      await this.#removeProjectFileTransaction();
    } catch (error: any) {
      try {
        await atomicWriteProjectFile(PROJID_PATH, projectFiles.projidText);
        await atomicWriteProjectFile(PROJECTS_PATH, projectFiles.projectsText);
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
