import fs from "fs-extra";
import { constants } from "fs";
import * as lockfile from "proper-lockfile";

export interface LockedUploadFile {
  fd: number;
  releaseLock: () => Promise<void>;
}

function invalidUploadTarget(): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error("Upload target must be a regular file");
  error.code = "EINVALIDUPLOAD";
  return error;
}

export async function openLockedUploadFile(
  filePath: string,
  size: number,
  validatePath?: () => boolean
): Promise<LockedUploadFile> {
  try {
    const createFd = await fs.open(
      filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
    );
    await fs.close(createFd);
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
  }
  const initialStat = await fs.lstat(filePath);
  if (!initialStat.isFile() || initialStat.nlink !== 1) throw invalidUploadTarget();

  let fd: number | null = null;
  let releaseLock: (() => Promise<void>) | undefined;
  try {
    releaseLock = await lockfile.lock(filePath, { realpath: false });
    fd = await fs.open(filePath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    const [pathStat, fileStat] = await Promise.all([fs.lstat(filePath), fs.fstat(fd)]);
    if (
      !pathStat.isFile() ||
      pathStat.nlink !== 1 ||
      pathStat.dev !== fileStat.dev ||
      pathStat.ino !== fileStat.ino
    ) {
      throw invalidUploadTarget();
    }
    if (validatePath && !validatePath()) throw invalidUploadTarget();
    await fs.ftruncate(fd, size);
    return { fd, releaseLock };
  } catch (error) {
    if (fd !== null) {
      await fs.close(fd).catch(() => {});
    }
    if (releaseLock) {
      await releaseLock().catch(() => {});
    }
    throw error;
  }
}
