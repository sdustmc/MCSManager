const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  resolveDockerHostWorkspacePath,
  getStorageQuotaLimits,
  parseXfsQuotaReport,
  normalizeStoragePools,
  pathsOverlap,
  GIB
} = require("../src/service/storage_quota_utils.ts");

test("maps the actual relative instance directory into the host workspace", () => {
  assert.equal(
    resolveDockerHostWorkspacePath(
      "/srv/mcsm/instances/custom-name",
      "/srv/mcsm/instances",
      "/host/instances"
    ),
    path.normalize("/host/instances/custom-name")
  );
});

test("quota limits use GiB and preserve the existing ten percent buffer by default", () => {
  const limits = getStorageQuotaLimits({ maxSpace: 100, enableHardStorageQuota: true });
  assert.equal(limits.allocatedBytes, 100 * GIB);
  assert.equal(limits.hardLimitBytes, 110 * GIB);
  assert.equal(
    getStorageQuotaLimits({ maxSpace: 100, storageQuotaBufferPercent: 0 }).hardLimitBytes,
    100 * GIB
  );
});

test("rejects invalid quota input instead of interpolating it into a command", () => {
  for (const value of [NaN, Infinity, -1, "1; reboot", 1048577])
    assert.throws(() => getStorageQuotaLimits({ maxSpace: value }));
  for (const value of [-1, 101, Infinity])
    assert.throws(() => getStorageQuotaLimits({ storageQuotaBufferPercent: value }));
  for (const value of [-1, 1.5, Infinity, 4294967296])
    assert.throws(() => getStorageQuotaLimits({ storageQuotaInodes: value }));
  assert.throws(() => getStorageQuotaLimits({ enableHardStorageQuota: true, maxSpace: 0 }));
});

test("parses numeric XFS block and inode reports without locale-dependent sizes", () => {
  const report =
    "Project quota on /data\n#200000 512 0 1024 00 [------]\n200001 0 0 0 00 [------]\n";
  assert.deepEqual(parseXfsQuotaReport(report).get(200000), {
    used: 524288,
    soft: 0,
    hard: 1048576
  });
  assert.deepEqual(parseXfsQuotaReport(report, 1).get(200000), { used: 512, soft: 0, hard: 1024 });
  assert.throws(() => parseXfsQuotaReport("200000 9999999999999999999999 0 100"));
});

test("detects parent-child project overlaps without confusing sibling prefixes", () => {
  assert.equal(pathsOverlap("/data/one", "/data/one/subdir"), true);
  assert.equal(pathsOverlap("/data/one/subdir", "/data/one"), true);
  assert.equal(pathsOverlap("/data/one", "/data/one-more"), false);
});

test("validates storage pool IDs, paths, reservations, and duplicate entries", () => {
  const valid = { id: "pool-1", name: "Primary", path: "/data/instances", reserveGiB: 10 };
  assert.deepEqual(normalizeStoragePools([valid]), [valid]);
  for (const value of [
    null,
    {},
    [valid, valid],
    [{ ...valid, path: "/" }],
    [{ ...valid, path: "relative" }],
    [{ ...valid, path: "/data\nother" }],
    [{ ...valid, reserveGiB: -1 }]
  ])
    assert.throws(() => normalizeStoragePools(value));
});

test("does not map the workspace root or paths outside it", () => {
  assert.equal(
    resolveDockerHostWorkspacePath("/srv/mcsm/instances", "/srv/mcsm/instances", "/host/instances"),
    path.normalize("/srv/mcsm/instances")
  );
  assert.equal(
    resolveDockerHostWorkspacePath("/srv/mcsm/other", "/srv/mcsm/instances", "/host/instances"),
    path.normalize("/srv/mcsm/other")
  );
});

test("pool inspection can map the root without allowing paths outside the workspace", () => {
  const options = { allowRoot: true };
  assert.equal(
    resolveDockerHostWorkspacePath("/srv/instances", "/srv/instances", "/host/instances", options),
    path.normalize("/host/instances")
  );
  assert.equal(
    resolveDockerHostWorkspacePath("/srv/other", "/srv/instances", "/host/instances", options),
    path.normalize("/srv/other")
  );
  assert.equal(
    resolveDockerHostWorkspacePath(
      "/srv/instances/..pool/app",
      "/srv/instances",
      "/host/instances",
      options
    ),
    path.normalize("/host/instances/..pool/app")
  );
});
