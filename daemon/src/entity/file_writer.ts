import fs from "fs-extra";
import path from "path";
import * as lockfile from "proper-lockfile";
import { $t } from "../i18n";
import logger from "../service/log";
import { openLockedUploadFile } from "../service/upload_file_lock";
import FileManager from "../service/system_file";
import uploadManager from "../service/upload_manager";
import { applyDockerRunAsOwnership } from "../service/upload_ownership_service";
import { selectArchiveOwnershipTargets } from "../service/upload_ownership_utils";
import { addChunkRange, type ChunkRange, isChunkRangeFullyCovered } from "../tools/chunk_range";
import { globalConfiguration, globalEnv } from "./config";
import Instance from "./instance/instance";
import storageQuotaOperations from "../service/storage_quota_operation_service";

export default class FileWriter {
  readonly path: string;
  id?: string;
  cwd?: string;
  private releaseLock?: () => Promise<void>;
  private fd: number | null = null;
  private completion?: Promise<void>;
  private completionFailed = false;
  private fileTaskReserved = false;
  private pendingWrites = new Set<Promise<void>>();
  private stopPromise?: Promise<void>;
  private stopping = false;
  private ownsFile = false;
  readonly received: ChunkRange[] = [];
  lastUpdate: number = Date.now();

  constructor(
    public readonly instance: Instance,
    private filename: string,
    public readonly size: number,
    private unzip: boolean,
    private zipCode: string,
    filePath: string,
    private deleteAfterUnzip: boolean = false
  ) {
    if (!FileManager.checkFileName(path.basename(this.filename)))
      throw new Error("Access denied: Malformed file name");
    if (!Number.isSafeInteger(this.size) || this.size < 0) {
      throw new Error($t("TXT_CODE_http_router.invalidUploadSize"));
    }

    this.path = filePath;
    this.cwd = instance.absoluteCwdPath();
  }

  static async getPath(cwd: string, dir: string, filename: string, overwrite: boolean) {
    const fileManager = new FileManager(cwd);

    const ext = path.extname(filename);
    const basename = path.basename(filename, ext);

    let tempFileSaveName = basename + ext;
    let counter = 1;

    const checkFile = async (name: string) => {
      const absolutePath = fileManager.toAbsolutePath(path.normalize(path.join(dir, name)));
      const isLock = await lockfile
        .check(absolutePath)
        .then((isLock) => isLock)
        .catch(() => false);
      const isAccess = await fs
        .access(absolutePath)
        .then(() => true)
        .catch(() => false);
      return isAccess && !isLock && !overwrite;
    };

    while (await checkFile(tempFileSaveName)) {
      if (counter == 1) {
        tempFileSaveName = `${basename}-copy${ext}`;
      } else {
        tempFileSaveName = `${basename}-copy-${counter}${ext}`;
      }
      counter++;
      if (counter > 100) {
        throw new Error("Access denied: File name already exists!");
      }
    }

    const fileSaveRelativePath = path.normalize(path.join(dir, tempFileSaveName));

    if (!fileManager.checkPath(fileSaveRelativePath))
      throw new Error("Access denied: Invalid destination");

    return fileManager.toAbsolutePath(fileSaveRelativePath);
  }

  isFullyReceived(): boolean {
    return this.size === 0 || isChunkRangeFullyCovered(this.received, this.size);
  }

  hasFailed(): boolean {
    return this.completionFailed;
  }

  async init() {
    storageQuotaOperations.assertWritable(this.instance);
    if (this.fd != null) return;
    try {
      const fileManager = new FileManager(this.cwd);
      const lockedFile = await openLockedUploadFile(this.path, this.size, () =>
        fileManager.checkPath(this.path)
      );
      this.fd = lockedFile.fd;
      this.releaseLock = lockedFile.releaseLock;
      this.ownsFile = true;
    } catch (error: any) {
      if (error?.code === "ELOCKED") {
        throw new Error($t("TXT_CODE_http_router.fileLocked"));
      }
      if (error?.code === "EINVALIDUPLOAD" || error?.code === "ELOOP") {
        throw new Error($t("TXT_CODE_system_file.illegalAccess"));
      }
      throw error;
    }
  }

  async write(offset: number, chunk: Buffer) {
    storageQuotaOperations.assertWritable(this.instance);
    if (this.stopping) throw new Error($t("TXT_CODE_http_router.fileNotOpen"));
    if (this.completion) return await this.completion;
    const operation = this.writeChunk(offset, chunk);
    this.pendingWrites.add(operation);
    operation.catch(() => {
      this.stopping = true;
      this.completionFailed = true;
    });
    try {
      await operation;
    } catch (error) {
      this.pendingWrites.delete(operation);
      try {
        await this.stop();
      } catch (cleanupError) {
        logger.error("Error cleaning failed file upload:", this.path, cleanupError);
      }
      throw error;
    } finally {
      this.pendingWrites.delete(operation);
    }
    if (!this.stopping && this.isFullyReceived()) await this.done();
  }

  private async writeChunk(offset: number, chunk: Buffer) {
    if (this.cwd !== this.instance.absoluteCwdPath())
      throw new Error($t("TXT_CODE_system_file.illegalAccess"));
    this.lastUpdate = Date.now();
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error($t("TXT_CODE_http_router.invalidUploadOffset"));
    }
    if (offset > this.size - chunk.length) {
      throw new Error($t("TXT_CODE_http_router.uploadExceedsSize"));
    }
    if (this.stopping || this.fd === null)
      throw new Error($t("TXT_CODE_http_router.fileNotOpen"));
    let written = 0;
    while (written < chunk.length) {
      const result = await fs.write(
        this.fd,
        chunk,
        written,
        chunk.length - written,
        offset + written
      );
      if (result.bytesWritten <= 0) throw new Error($t("TXT_CODE_http_router.updateErr"));
      written += result.bytesWritten;
    }

    addChunkRange(this.received, offset, offset + chunk.length);
  }

  async completeIfCovered() {
    if (this.fd !== null && this.isFullyReceived()) await this.done();
  }

  async done() {
    if (!this.completion) {
      if (this.unzip) this.reserveFileTask();
      this.completion = this.complete();
    }
    return await this.completion;
  }

  private reserveFileTask() {
    const maxFileTask = globalConfiguration.config.maxFileTask;
    const fileLock = this.instance.info.fileLock ?? 0;
    if (fileLock >= maxFileTask) {
      throw new Error(
        $t("TXT_CODE_file_router.unzipLimit", {
          maxFileTask,
          fileLock
        })
      );
    }

    globalEnv.fileTaskCount++;
    this.instance.info.fileLock = fileLock + 1;
    this.fileTaskReserved = true;
  }

  private releaseFileTask() {
    if (!this.fileTaskReserved) return;
    this.fileTaskReserved = false;
    globalEnv.fileTaskCount--;
    const fileLock = this.instance.info.fileLock ?? 1;
    this.instance.info.fileLock = Math.max(0, fileLock - 1);
  }

  private async closeFile() {
    if (this.fd === null) return;
    const fd = this.fd;
    const releaseLock = this.releaseLock;
    this.fd = null;
    this.releaseLock = undefined;
    try {
      await fs.close(fd);
    } finally {
      await releaseLock?.();
    }
  }

  private async complete() {
    try {
      await Promise.all(this.pendingWrites);
      if (this.stopping) throw new Error($t("TXT_CODE_http_router.fileNotOpen"));
      await this.closeFile();
      logger.info("Browser Uploaded File:", this.path);

      if (this.unzip) {
        try {
          const instanceFiles = new FileManager(this.cwd);
          let ownershipTargets: string[] = [];
          await instanceFiles.unzip(
            this.path,
            path.dirname(this.path),
            this.zipCode,
            async (entryPaths) => {
              ownershipTargets = await selectArchiveOwnershipTargets(entryPaths);
            }
          );
          logger.info("File unzipped:", this.path);
          if (!this.deleteAfterUnzip) {
            ownershipTargets.push(this.path);
          }
          await applyDockerRunAsOwnership(this.instance, ownershipTargets);
        } finally {
          if (this.deleteAfterUnzip && (await fs.pathExists(this.path))) {
            await fs.remove(this.path);
            logger.info("Temporary zip deleted:", this.path);
          }
        }
      } else {
        await applyDockerRunAsOwnership(this.instance, [this.path]);
      }

      if (this.id != null) {
        uploadManager.delete(this.id);
      }
    } catch (error) {
      this.completionFailed = true;
      throw error;
    } finally {
      this.releaseFileTask();
    }
  }

  async stop() {
    this.stopping = true;
    this.stopPromise ||= this.stopInternal();
    return this.stopPromise;
  }

  private async stopInternal() {
    await Promise.allSettled(this.pendingWrites);
    if (this.completion) {
      await this.completion.catch(() => {});
    }
    let cleanupError: unknown;
    try {
      await this.closeFile();
    } catch (error) {
      cleanupError = error;
    }
    if (this.id != null) {
      uploadManager.delete(this.id);
    }
    if (this.ownsFile) {
      try {
        await fs.remove(this.path);
      } catch (error) {
        cleanupError ||= error;
      }
    }
    logger.info("Browser Upload Task Stopped:", this.path);
    if (cleanupError) throw cleanupError;
  }

  private readStreamToHash(
    filePath: string,
    hash: any,
    options?: { start: number; end: number }
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filePath, options);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", resolve);
      stream.on("error", reject);
    });
  }
}
