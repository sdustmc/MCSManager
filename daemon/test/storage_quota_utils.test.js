const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { resolveDockerHostWorkspacePath } = require("../src/service/storage_quota_utils.ts");

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
