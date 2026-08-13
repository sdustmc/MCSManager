import fs from "fs-extra";

function isNotFoundError(error: any): boolean {
  return error?.code === "ENOENT";
}

export async function selectArchiveOwnershipTargets(entryPaths: string[]): Promise<string[]> {
  const targets: string[] = [];
  for (const entryPath of entryPaths) {
    try {
      const stat = await fs.lstat(entryPath);
      if (!stat.isDirectory()) targets.push(entryPath);
    } catch (error: any) {
      if (isNotFoundError(error)) {
        targets.push(entryPath);
        continue;
      }
      throw error;
    }
  }
  return targets;
}
