import path from "node:path";
import type {} from "../../../common/global";

export const GIB = 1024 ** 3;

export function getStorageQuotaLimits(config: IGlobalInstanceDockerConfig) {
  const allocationGiB = Number(config.maxSpace ?? 0);
  const bufferPercent = Number(config.storageQuotaBufferPercent ?? 10);
  const inodeLimit = Number(config.storageQuotaInodes ?? 0);
  const warningPercent = Number(config.storageQuotaWarningPercent ?? 80);
  if (
    !Number.isFinite(allocationGiB) ||
    allocationGiB < 0 ||
    allocationGiB > 1024 * 1024 ||
    !Number.isFinite(bufferPercent) ||
    bufferPercent < 0 ||
    bufferPercent > 100 ||
    !Number.isSafeInteger(inodeLimit) ||
    inodeLimit < 0 ||
    inodeLimit > 0xffffffff ||
    !Number.isFinite(warningPercent) ||
    warningPercent < 1 ||
    warningPercent > 100 ||
    (config.enableHardStorageQuota && allocationGiB <= 0) ||
    (config.storagePoolId && !/^[a-zA-Z0-9_-]{1,64}$/.test(config.storagePoolId))
  )
    throw new RangeError("Invalid storage quota configuration");
  const allocatedBytes = Math.ceil(allocationGiB * GIB);
  return {
    allocatedBytes,
    hardLimitBytes: Math.ceil(((allocatedBytes / 1024) * (100 + bufferPercent)) / 100) * 1024,
    inodeLimit,
    bufferPercent,
    warningPercent
  };
}

export interface IXfsQuotaRecord {
  used: number;
  soft: number;
  hard: number;
}

export function parseXfsQuotaReport(text: string, unit = 1024) {
  const records = new Map<number, IXfsQuotaRecord>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^#?(\d+)\s+(\d+)\s+(\d+)\s+(\d+)(?:\s|$)/);
    if (!match) continue;
    const id = Number(match[1]);
    const [used, soft, hard] = match.slice(2, 5).map((value) => Number(value) * unit);
    if (![id, used, soft, hard].every(Number.isSafeInteger))
      throw new RangeError("Invalid XFS quota report value");
    records.set(id, { used, soft, hard });
  }
  return records;
}

export function pathsOverlap(first: string, second: string) {
  const contains = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return (
      !relative ||
      (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))
    );
  };
  return contains(first, second) || contains(second, first);
}

export function normalizeStoragePools(value: unknown): IStoragePoolConfig[] {
  if (!Array.isArray(value) || value.length > 32) throw new RangeError("Invalid storage pools");
  const ids = new Set<string>();
  const paths = new Set<string>();
  return value.map((pool) => {
    if (
      !pool ||
      typeof pool.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(pool.id) ||
      typeof pool.name !== "string" ||
      !pool.name.trim() ||
      pool.name.length > 80 ||
      typeof pool.path !== "string" ||
      !path.isAbsolute(pool.path) ||
      /[\0\r\n:]/.test(pool.path) ||
      pool.path.length > 4096 ||
      path.normalize(pool.path) === path.parse(pool.path).root ||
      !Number.isFinite(Number(pool.reserveGiB)) ||
      Number(pool.reserveGiB) < 0 ||
      Number(pool.reserveGiB) > 1024 * 1024 ||
      ids.has(pool.id) ||
      paths.has(path.normalize(pool.path))
    )
      throw new RangeError("Invalid storage pools");
    ids.add(pool.id);
    paths.add(path.normalize(pool.path));
    return {
      id: pool.id,
      name: pool.name.trim(),
      path: path.normalize(pool.path),
      reserveGiB: Number(pool.reserveGiB)
    };
  });
}

export function resolveDockerHostWorkspacePath(
  cwd: string,
  defaultInstanceDir: string,
  hostWorkspacePath: string | null | undefined,
  options: { allowRoot?: boolean } = {}
) {
  const normalizedCwd = path.normalize(cwd);
  const normalizedDefaultDir = path.normalize(defaultInstanceDir);
  if (!hostWorkspacePath) return normalizedCwd;

  const relativePath = path.relative(normalizedDefaultDir, normalizedCwd);
  // Only storage pool inspection may translate the root; instance quotas need a descendant.
  if (
    (!relativePath && !options.allowRoot) ||
    relativePath === ".." ||
    relativePath.startsWith(".." + path.sep) ||
    path.isAbsolute(relativePath)
  ) {
    return normalizedCwd;
  }
  return path.normalize(path.join(hostWorkspacePath, relativePath));
}
