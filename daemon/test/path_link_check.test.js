const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  isPathOutsideWorkspace,
  isUnsafeArchiveTarget
} = require("../src/tools/path_link_check.ts");

test("detects a final symlink that resolves outside the workspace", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcsm-path-link-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const workspace = path.join(tempDir, "workspace");
  const outsideFile = path.join(tempDir, "outside.txt");
  const linkedFile = path.join(workspace, "payload.txt");
  await fs.mkdir(workspace);
  await fs.writeFile(outsideFile, "outside");
  await fs.symlink(outsideFile, linkedFile);

  assert.equal(isPathOutsideWorkspace(workspace, linkedFile), true);
  assert.equal(isPathOutsideWorkspace(workspace, path.join(workspace, "new.txt")), false);
});

test("rejects existing links as archive extraction targets", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcsm-archive-target-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const regularFile = path.join(tempDir, "regular.txt");
  const symbolicLink = path.join(tempDir, "symbolic.txt");
  const hardLink = path.join(tempDir, "hard.txt");
  await fs.writeFile(regularFile, "content");
  await fs.symlink(regularFile, symbolicLink);
  await fs.link(regularFile, hardLink);

  assert.equal(isUnsafeArchiveTarget(symbolicLink), true);
  assert.equal(isUnsafeArchiveTarget(hardLink), true);
  assert.equal(isUnsafeArchiveTarget(path.join(tempDir, "missing.txt")), false);
});
