const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { test, beforeEach, afterEach, after, mock } = require("node:test");

const project = path.resolve(__dirname, "../..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcsm-config-audit-"));
const cleanRoot = () => fs.rmSync(root, { recursive: true, force: true });
process.once("exit", cleanRoot);
const oldCwd = process.cwd();
const oldResolve = Module._resolveFilename;
const oldInterval = global.setInterval;
const intervals = [];
global.setInterval = (...args) => {
  const timer = oldInterval(...args);
  intervals.push(timer);
  return timer;
};
Module._resolveFilename = function (request, ...args) {
  if (request.startsWith("@languages/"))
    request = path.join(project, "languages", request.slice(11));
  if (request === "mcsmanager-common") request = path.join(project, "common/src/index.ts");
  return oldResolve.call(this, request, ...args);
};
process.chdir(root);
const tsNode = require("ts-node");
process[tsNode.REGISTER_INSTANCE]?.enabled(false);
tsNode.register({ project: path.join(project, "panel/tsconfig.json"), files: true });
let audit, RemoteRequest, remotes, operationLogger, logger;
try {
  audit = require("../src/app/service/instance_config_audit.ts").updateInstanceWithAudit;
  RemoteRequest = require("../src/app/service/remote_command.ts").default;
  remotes = require("../src/app/service/remote_service.ts").default;
  operationLogger = require("../src/app/service/operation_logger.ts");
  ({ logger } = require("../src/app/service/log.ts"));
} finally {
  process.chdir(oldCwd);
  Module._resolveFilename = oldResolve;
  global.setInterval = oldInterval;
}

let config, records, errors, complete, fail, reads, context;
beforeEach(() => {
  config = { nickname: "Server", docker: { maxSpace: 10, env: ["TOKEN=old"] } };
  records = [];
  errors = [];
  reads = [];
  context = { operator: "alice" };
  mock.method(remotes, "getInstance", () => ({ socket: {} }));
  mock.method(operationLogger, "getOperationLoggerOperator", (ctx) => ({
    operator_name: ctx.operator
  }));
  mock.method(operationLogger.operationLogger, "log", (...args) => records.push(args));
  mock.method(logger, "error", (...args) => errors.push(args));
  mock.method(RemoteRequest.prototype, "request", async (event, payload, timeout) => {
    reads.push(event);
    assert.equal(payload.instanceUuid, "instance1");
    if (event === "instance/detail") return { config: structuredClone(config) };
    assert.equal(event, "instance/storage_quota_wait");
    assert.equal(timeout, 30 * 60 * 1000);
    return new Promise((resolve, reject) => {
      complete = resolve;
      fail = reject;
    });
  });
});
afterEach(() => mock.restoreAll());
after(async () => {
  intervals.forEach(clearInterval);
  await new Promise((resolve) => require("log4js").shutdown(resolve));
  cleanRoot();
  process.removeListener("exit", cleanRoot);
});

test("queued quota changes return immediately and are audited after verified completion", async () => {
  const response = await audit(context, "node1", "instance1", async () => ({
    instanceUuid: "instance1",
    storageQuotaStatus: "applying"
  }));
  assert.equal(response.storageQuotaStatus, "applying");
  assert.deepEqual(records, []);
  assert.deepEqual(reads, ["instance/detail", "instance/storage_quota_wait"]);
  context.operator = "another-user";
  config.docker.maxSpace = 20;
  complete({ config: structuredClone(config) });
  await new Promise(setImmediate);
  assert.equal(records.length, 1);
  assert.equal(records[0][0], "instance_config_change");
  assert.equal(records[0][1].operator_name, "alice");
  assert.deepEqual(records[0][1].config_before, { docker: { maxSpace: 10 } });
  assert.deepEqual(records[0][1].config_after, { docker: { maxSpace: 20 } });
  assert.deepEqual(errors, []);
});

test("failed or timed-out quota operations log an audit error without a success event", async () => {
  await audit(context, "node1", "instance1", async () => ({ storageQuotaStatus: "applying" }));
  fail(new Error("Quota operation failed"));
  await new Promise(setImmediate);
  assert.deepEqual(records, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0].at(-1).message, /Quota operation failed/);
});

test("ordinary synchronous updates retain their configuration audit", async () => {
  await audit(context, "node1", "instance1", async () => {
    config.nickname = "Renamed";
    return { instanceUuid: "instance1" };
  });
  assert.deepEqual(reads, ["instance/detail", "instance/detail"]);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0][1].config_after, { nickname: "Renamed" });
});

test("unverified completion payloads cannot produce a successful audit record", async () => {
  await audit(context, "node1", "instance1", async () => ({ storageQuotaStatus: "applying" }));
  complete({});
  await new Promise(setImmediate);
  assert.deepEqual(records, []);
  assert.equal(errors.length, 1);
});
