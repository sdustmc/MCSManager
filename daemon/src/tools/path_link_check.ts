import fs from "fs-extra";
import path from "path";

/**
 * Resolves the real absolute path by walking backwards from the target to
 * find the deepest existing ancestor, then calling realpathSync on it and
 * appending the non-existent tail segments.
 *
 * Returns null if realpathSync fails on the existing ancestor.
 */
export function resolveRealPath(absolutePath: string): string | null {
  let dir = path.resolve(absolutePath);
  const root = path.parse(dir).root;
  const missed: string[] = [];

  while (true) {
    try {
      fs.lstatSync(dir);
      try {
        return path.join(fs.realpathSync(dir), ...missed);
      } catch {
        return null;
      }
    } catch {
      if (dir === root) return null;
      missed.unshift(path.basename(dir));
      dir = path.dirname(dir);
    }
  }
}

export function isPathOutsideWorkspace(topPath: string, targetPath: string): boolean {
  const realTop = resolveRealPath(topPath);
  const realTarget = resolveRealPath(targetPath);
  if (!realTop || !realTarget) return true;

  const relative = path.relative(realTop, realTarget);
  return relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative);
}

export function isUnsafeArchiveTarget(targetPath: string): boolean {
  try {
    const stat = fs.lstatSync(targetPath);
    return stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1);
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    return true;
  }
}
