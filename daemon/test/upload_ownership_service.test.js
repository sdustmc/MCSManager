const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { selectArchiveOwnershipTargets } = require("../src/service/upload_ownership_utils.ts");

test("selects archive files and new directories without changing existing directories", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcsm-upload-owner-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const existingDirectory = path.join(tempDir, "existing");
  const existingFile = path.join(existingDirectory, "server.properties");
  const newDirectory = path.join(tempDir, "new-directory");
  await fs.mkdir(existingDirectory);
  await fs.writeFile(existingFile, "online-mode=true");

  const targets = await selectArchiveOwnershipTargets([
    existingDirectory,
    existingFile,
    newDirectory
  ]);

  assert.deepEqual(targets, [existingFile, newDirectory]);
});
