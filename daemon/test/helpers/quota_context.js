const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { after } = require("node:test");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcsm-quota-test-"));
const cleanRoot = () => fs.rmSync(root, { recursive: true, force: true });
process.once("exit", cleanRoot);
const project = path.resolve(__dirname, "../../..");
const originalDirectory = process.cwd();
const originalResolve = Module._resolveFilename;
const originalInterval = global.setInterval;
const intervals = [];
global.setInterval = (...args) => {
  const timer = originalInterval(...args);
  intervals.push(timer);
  return timer;
};
Module._resolveFilename = function (request, ...args) {
  if (request.startsWith("@languages/"))
    request = path.join(project, "languages", request.slice(11));
  if (request === "mcsmanager-common") request = path.join(project, "common/src/index.ts");
  return originalResolve.call(this, request, ...args);
};
process.chdir(root);
const tsNode = require("ts-node");
process[tsNode.REGISTER_INSTANCE]?.enabled(false);
tsNode.register({
  project: path.join(project, "daemon/tsconfig.json"),
  files: true,
  compilerOptions: { skipLibCheck: true }
});
let context;
try {
  context = {
    root,
    Storage: require("../../src/common/system_storage.ts").default,
    QuotaService: require("../../src/service/storage_quota_service.ts").StorageQuotaService,
    Operations: require("../../src/service/storage_quota_operation_service.ts")
      .StorageQuotaOperationService,
    config: require("../../src/entity/config.ts").globalConfiguration.config,
    logger: require("../../src/service/log.ts").default,
    ...require("../../src/service/storage_quota_utils.ts")
  };
} finally {
  Module._resolveFilename = originalResolve;
  global.setInterval = originalInterval;
  process.chdir(originalDirectory);
}
after(async () => {
  intervals.forEach(clearInterval);
  await new Promise((resolve) => require("log4js").shutdown(resolve));
  cleanRoot();
  process.removeListener("exit", cleanRoot);
});

function createInstance(id = "instance1", docker = {}) {
  const cwd = path.join(root, "xfs", id);
  fs.mkdirSync(cwd, { recursive: true });
  return {
    instanceUuid: id,
    config: {
      cwd,
      processType: "docker",
      docker: { maxSpace: 10, enableHardStorageQuota: true, ...docker }
    },
    info: {},
    status: () => 0,
    absoluteCwdPath() {
      return path.resolve(this.config.cwd);
    },
    println() {},
    parameters(patch) {
      this.config = {
        ...this.config,
        ...patch,
        docker: { ...this.config.docker, ...patch.docker }
      };
      context.Storage.store("InstanceConfig", this.instanceUuid, this.config);
    },
    async updateConfig(patch) {
      this.parameters(patch);
    },
    async restoreConfig(config) {
      this.config = structuredClone(config);
      context.Storage.store("InstanceConfig", this.instanceUuid, this.config);
    }
  };
}

function loadInstanceRuntime(includeRouters = false) {
  const currentDirectory = process.cwd();
  const currentResolve = Module._resolveFilename;
  const currentInterval = global.setInterval;
  global.setInterval = (...args) => {
    const timer = originalInterval(...args);
    intervals.push(timer);
    return timer;
  };
  Module._resolveFilename = function (request, ...args) {
    if (request.startsWith("@languages/"))
      request = path.join(project, "languages", request.slice(11));
    if (request === "mcsmanager-common") request = path.join(project, "common/src/index.ts");
    return originalResolve.call(this, request, ...args);
  };
  try {
    process.chdir(root);
    const runtime = {
      Instance: require("../../src/entity/instance/instance.ts").default,
      InstanceConfig: require("../../src/entity/instance/Instance_config.ts").default,
      Dispatcher: require("../../src/entity/commands/dispatcher.ts").default
    };
    if (includeRouters) {
      runtime.routerApp = require("../../src/service/router.ts").routerApp;
      runtime.httpRouter = require("../../src/routers/http_router.ts").default;
    }
    return runtime;
  } finally {
    process.chdir(currentDirectory);
    Module._resolveFilename = currentResolve;
    global.setInterval = currentInterval;
  }
}

module.exports = { ...context, createInstance, loadInstanceRuntime };
