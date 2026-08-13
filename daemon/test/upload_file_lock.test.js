const assert = require("node:assert/strict");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const lockfile = require("proper-lockfile");
const test = require("node:test");

const { openLockedUploadFile } = require("../src/service/upload_file_lock.ts");

test("does not truncate a file when its upload lock is already held", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcsm-upload-lock-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const filePath = path.join(tempDir, "server.jar");
  await fs.writeFile(filePath, "original-content");
  const releaseExistingLock = await lockfile.lock(filePath);

  await assert.rejects(openLockedUploadFile(filePath, 2), (error) => {
    assert.equal(error.code, "ELOCKED");
    return true;
  });
  assert.equal(await fs.readFile(filePath, "utf8"), "original-content");

  await releaseExistingLock();
  const lockedFile = await openLockedUploadFile(filePath, 2);
  fsSync.closeSync(lockedFile.fd);
  await lockedFile.releaseLock();

  assert.equal((await fs.stat(filePath)).size, 2);
});

test("rejects a symbolic link upload target without modifying its destination", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcsm-upload-link-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const outsideFile = path.join(tempDir, "outside.txt");
  const linkedFile = path.join(tempDir, "upload.txt");
  await fs.writeFile(outsideFile, "outside-content");
  await fs.symlink(outsideFile, linkedFile);

  await assert.rejects(openLockedUploadFile(linkedFile, 2), (error) => {
    assert.equal(error.code, "EINVALIDUPLOAD");
    return true;
  });
  assert.equal(await fs.readFile(outsideFile, "utf8"), "outside-content");
});

test("rejects a hard-linked upload target without modifying shared data", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcsm-upload-hardlink-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const sharedFile = path.join(tempDir, "shared.txt");
  const uploadFile = path.join(tempDir, "upload.txt");
  await fs.writeFile(sharedFile, "shared-content");
  await fs.link(sharedFile, uploadFile);

  await assert.rejects(openLockedUploadFile(uploadFile, 2), (error) => {
    assert.equal(error.code, "EINVALIDUPLOAD");
    return true;
  });
  assert.equal(await fs.readFile(sharedFile, "utf8"), "shared-content");
});

test("validates the resolved upload path before truncating", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcsm-upload-validate-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const filePath = path.join(tempDir, "server.jar");
  await fs.writeFile(filePath, "original-content");

  await assert.rejects(
    openLockedUploadFile(filePath, 2, () => false),
    (error) => {
      assert.equal(error.code, "EINVALIDUPLOAD");
      return true;
    }
  );
  assert.equal(await fs.readFile(filePath, "utf8"), "original-content");
});
