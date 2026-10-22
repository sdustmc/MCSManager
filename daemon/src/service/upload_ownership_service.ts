import fs from "fs-extra";
import type Instance from "../entity/instance/instance";
import { $t } from "../i18n";
import { resolveInstanceFileOwnership, syncInstancePathOwnership } from "../tools/file_ownership";
import { resolveDockerRunAsUserIds, type RunAsUserIds } from "../tools/system_user";
import logger from "./log";
import FileManager from "./system_file";

function isNotFoundError(error: any): boolean {
  return error?.code === "ENOENT";
}

export async function applyDockerRunAsOwnership(
  instance: Instance,
  targetPaths: string[]
): Promise<void> {
  const runAs = instance.config.runAs?.trim();
  if (process.platform === "win32" || !runAs) return;

  let owner: RunAsUserIds | undefined = await resolveInstanceFileOwnership(instance);
  if (!owner) {
    if (process.platform !== "linux" || instance.config.processType !== "docker") return;
    try {
      owner = await resolveDockerRunAsUserIds(runAs);
    } catch (error: any) {
      logger.warn(
        "Skipping Docker upload ownership because the host cannot resolve " +
          runAs +
          ": " +
          error.message
      );
      return;
    }
  }

  const fileManager = new FileManager(instance.absoluteCwdPath());
  for (const targetPath of new Set(targetPaths)) {
    try {
      if (!fileManager.checkPath(targetPath)) {
        throw new Error($t("TXT_CODE_file_ownership.outsideWorkspace"));
      }

      const gid = owner.gid ?? (await fs.lstat(targetPath)).gid;
      await syncInstancePathOwnership(instance, targetPath, { uid: owner.uid, gid });
    } catch (error: any) {
      if (isNotFoundError(error)) continue;
      logger.error("Failed to set Docker upload ownership for " + targetPath + ":", error);
      throw error;
    }
  }
}
