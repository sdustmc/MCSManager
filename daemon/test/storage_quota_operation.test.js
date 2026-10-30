const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { beforeEach, afterEach, test, mock } = require("node:test");
const {
  root,
  Storage,
  Operations,
  createInstance,
  getStorageQuotaLimits,
  logger,
  loadInstanceRuntime
} = require("./helpers/quota_context");

let operations, quota, faults, applied, instances, events;
beforeEach(() => {
  fs.rmSync(path.join(root, "data"), { recursive: true, force: true });
  fs.rmSync(path.join(root, "xfs"), { recursive: true, force: true });
  faults = {};
  applied = new Map();
  instances = [];
  events = [];
  mock.method(logger, "error", () => {});
  mock.method(logger, "info", () => {});
  quota = {
    validateConfig: getStorageQuotaLimits,
    resolveDockerDiskWorkspace(instance) {
      return instance.absoluteCwdPath();
    },
    resolvePoolDirectory(pool, uuid) {
      return path.join(root, "xfs", pool, uuid);
    },
    async inspectWorkspace() {
      if (faults.check) throw faults.check;
      return { mountPoint: path.join(root, "xfs") };
    },
    async checkStoragePool() {
      if (faults.pool) await faults.pool();
    },
    async ensureDockerHardQuota(instance, workspace, size) {
      events.push({ id: instance.instanceUuid, size });
      applied.set(instance.instanceUuid, size);
      instance.config.docker.storageQuotaProjectId = 200000;
      if (faults.apply) await faults.apply(size);
    },
    async deleteDockerHardQuotaIfManaged(instance) {
      if (faults.clear) throw faults.clear;
      applied.delete(instance.instanceUuid);
      instance.config.docker.storageQuotaProjectId = undefined;
    },
    async readUsage(instance) {
      if (faults.readback) throw faults.readback;
      return { state: "ready", ...getStorageQuotaLimits(instance.config.docker), usedBytes: 0 };
    },
    async refreshInstanceUsage() {},
    setInstanceProvider() {},
    dispose() {}
  };
  operations = new Operations(quota);
});
afterEach(async () => {
  await operations.dispose();
  mock.restoreAll();
});
const journalIds = () => Storage.list("StorageQuotaOperation");

test("saving a quota returns a job immediately and persists it until verified", async () => {
  const instance = createInstance();
  let release;
  faults.apply = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const result = operations.update(instance, { docker: { maxSpace: 20 } }, [instance]);
  assert.equal(result.storageQuotaStatus, "applying");
  assert.equal(operations.isApplying(instance), true);
  assert.deepEqual(journalIds(), [instance.instanceUuid]);
  while (!release) await new Promise(setImmediate);
  assert.equal(instance.info.storageQuota.state, "applying");
  release();
  await operations.wait(instance);
  assert.equal(instance.info.storageQuota.state, "ready");
  assert.equal(instance.config.docker.maxSpace, 20);
  assert.deepEqual(journalIds(), []);
});

test("invalid values do not create a job or a recovery journal", () => {
  const instance = createInstance();
  assert.throws(() => operations.update(instance, { docker: { maxSpace: -1 } }, [instance]));
  assert.equal(operations.isApplying(instance), false);
  assert.deepEqual(journalIds(), []);
});

test("preflight failure preserves the previous configuration", async () => {
  const instance = createInstance();
  faults.check = new Error("Enforcement is off");
  operations.update(instance, { docker: { maxSpace: 20 } }, [instance]);
  await operations.wait(instance);
  assert.equal(instance.config.docker.maxSpace, 10);
  assert.equal(instance.info.storageQuota.state, "error");
  assert.equal(events.length, 0);
  assert.deepEqual(journalIds(), []);
});

test("an ambiguous application failure restores the previous quota and configuration", async () => {
  const instance = createInstance();
  faults.apply = async (size) => {
    if (size === 20) throw new Error("Command timed out");
  };
  operations.update(instance, { docker: { maxSpace: 20 } }, [instance]);
  await operations.wait(instance);
  assert.equal(instance.info.storageQuota.state, "error");
  assert.equal(instance.config.docker.maxSpace, 10);
  assert.equal(applied.get(instance.instanceUuid), 10);
  assert.deepEqual(journalIds(), []);
});

test("failed readback also rolls the quota back", async () => {
  const instance = createInstance();
  faults.readback = new Error("Cannot verify quota");
  operations.update(instance, { docker: { maxSpace: 20 } }, [instance]);
  await operations.wait(instance);
  assert.equal(instance.config.docker.maxSpace, 10);
  assert.equal(applied.get(instance.instanceUuid), 10);
  assert.equal(instance.info.storageQuota.state, "error");
});

test("rollback failure leaves a durable journal that retry can recover", async () => {
  const instance = createInstance();
  faults.apply = async () => {
    throw new Error("Node failure");
  };
  operations.update(instance, { docker: { maxSpace: 20 } }, [instance]);
  await operations.wait(instance);
  assert.deepEqual(journalIds(), [instance.instanceUuid]);
  assert.equal(instance.info.storageQuota.state, "error");
  faults.apply = undefined;
  operations.retry(instance, [instance]);
  await operations.wait(instance);
  assert.equal(instance.config.docker.maxSpace, 10);
  assert.equal(instance.info.storageQuota.state, "ready");
  assert.deepEqual(journalIds(), []);
});

test("startup resumes an unfinished quota journal", async () => {
  const instance = createInstance();
  const previous = JSON.parse(JSON.stringify(instance.config));
  Storage.store("StorageQuotaOperation", instance.instanceUuid, {
    version: 1,
    instanceUuid: instance.instanceUuid,
    previous,
    next: { ...previous, docker: { ...previous.docker, maxSpace: 20 } }
  });
  instance.config.docker.maxSpace = 20;
  operations.initialize(() => [instance]);
  await operations.wait(instance);
  assert.equal(instance.config.docker.maxSpace, 10);
  assert.equal(applied.get(instance.instanceUuid), 10);
  assert.deepEqual(journalIds(), []);
});

test("the same instance cannot start two quota jobs", async () => {
  const instance = createInstance();
  operations.update(instance, { docker: { maxSpace: 20 } }, [instance]);
  assert.throws(
    () => operations.update(instance, { docker: { maxSpace: 30 } }, [instance]),
    /in progress/
  );
  await operations.wait(instance);
  assert.equal(instance.config.docker.maxSpace, 20);
});

test("allocation checks and updates are serialized across instances", async () => {
  const first = createInstance("first");
  const second = createInstance("second");
  let active = false;
  faults.pool = async () => {
    assert.equal(active, false);
    active = true;
    await new Promise(setImmediate);
  };
  faults.apply = async () => {
    active = false;
  };
  operations.update(first, { docker: { maxSpace: 20 } }, [first, second]);
  operations.update(second, { docker: { maxSpace: 30 } }, [first, second]);
  await Promise.all([operations.wait(first), operations.wait(second)]);
  assert.equal(first.info.storageQuota.state, "ready");
  assert.equal(second.info.storageQuota.state, "ready");
  assert.deepEqual(
    events.map((event) => event.id),
    ["first", "second"]
  );
});

test("pool changes never discard or silently move existing files", async () => {
  const instance = createInstance();
  fs.writeFileSync(path.join(instance.config.cwd, "world.dat"), "saved world");
  const previousCwd = instance.config.cwd;
  operations.update(instance, { docker: { storagePoolId: "other" } }, [instance]);
  await operations.wait(instance);
  assert.equal(instance.config.cwd, previousCwd);
  assert.equal(fs.readFileSync(path.join(previousCwd, "world.dat"), "utf8"), "saved world");
  assert.equal(instance.info.storageQuota.state, "error");
});

test("an empty instance can select another storage pool", async () => {
  const instance = createInstance();
  operations.update(instance, { docker: { storagePoolId: "other" } }, [instance]);
  await operations.wait(instance);
  assert.equal(instance.config.cwd, path.join(root, "xfs/other", instance.instanceUuid));
  assert.equal(instance.info.storageQuota.state, "ready");
});

test("unrelated instance edits do not create quota work", () => {
  const instance = createInstance();
  assert.equal(operations.changesQuota(instance, { endTime: 1000 }), false);
  instance.config.docker.maxSpace = 0;
  assert.equal(operations.changesQuota(instance, { endTime: 2000 }), false);
});

test("soft disk limit changes use the ordinary configuration path", () => {
  const instance = createInstance("soft", { enableHardStorageQuota: false });
  assert.equal(operations.changesQuota(instance, { docker: { maxSpace: 20 } }), false);
});

test("disposal waits for a usage refresh and prevents new jobs", async () => {
  const instance = createInstance();
  let release;
  quota.refreshInstanceUsage = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  operations.initialize(() => [instance]);
  const disposal = operations.dispose();
  assert.throws(() => operations.update(instance, {}, [instance]), /in progress/);
  assert.throws(() => operations.retry(instance, [instance]), /in progress/);
  release();
  await disposal;
});

test("the client cannot select the quota project identifier", async () => {
  const instance = createInstance();
  instance.config.docker.storageQuotaProjectId = 200001;
  operations.update(instance, { docker: { storageQuotaProjectId: 123 } }, [instance]);
  await operations.wait(instance);
  assert.notEqual(instance.config.docker.storageQuotaProjectId, 123);
});

test("a malformed recovery record stays blocked without changing the instance", () => {
  const instance = createInstance();
  Storage.store("StorageQuotaOperation", instance.instanceUuid, {});
  Storage.writeFile(`StorageQuotaOperation/${instance.instanceUuid}.json`, "{broken");
  assert.throws(() => operations.retry(instance, [instance]), /needs recovery/);
  assert.equal(instance.config.docker.maxSpace, 10);
  assert.equal(operations.isApplying(instance), false);
  assert.deepEqual(journalIds(), [instance.instanceUuid]);
});

test("oversized recovery records are rejected before reading their contents", () => {
  const instance = createInstance();
  Storage.store("StorageQuotaOperation", instance.instanceUuid, {});
  Storage.writeFile(
    `StorageQuotaOperation/${instance.instanceUuid}.json`,
    " ".repeat(1024 * 1024 + 1)
  );
  mock.method(Storage, "readFile", () => {
    throw new Error("The oversized file must not be read");
  });
  assert.throws(() => operations.retry(instance, [instance]), /needs recovery/);
  assert.equal(operations.isApplying(instance), false);
});

test("failed quota saves restore unrelated and nested configuration fields", async () => {
  const instance = createInstance();
  instance.config.startCommand = "old-command";
  instance.config.docker.env = ["TOKEN=old-secret"];
  faults.apply = async (size) => {
    if (size === 20) throw new Error("Apply failed");
  };
  operations.update(
    instance,
    {
      startCommand: "new-command",
      docker: { maxSpace: 20, env: ["TOKEN=new-secret"] }
    },
    [instance]
  );
  await operations.wait(instance);
  assert.equal(instance.info.storageQuota.state, "error");
  assert.equal(instance.config.docker.maxSpace, 10);
  assert.equal(instance.config.startCommand, "old-command");
  assert.deepEqual(instance.config.docker.env, ["TOKEN=old-secret"]);
  const stored = JSON.parse(Storage.readFile(`InstanceConfig/${instance.instanceUuid}.json`));
  assert.equal(stored.startCommand, "old-command");
  assert.deepEqual(stored.docker.env, ["TOKEN=old-secret"]);
});

test("full recovery snapshots are private and survive a failed rollback", async () => {
  const instance = createInstance();
  instance.config.startCommand = "old-command";
  instance.config.docker.env = ["TOKEN=" + "x".repeat(20000)];
  faults.apply = async () => {
    throw new Error("Daemon interrupted");
  };
  operations.update(instance, { startCommand: "new-command", docker: { maxSpace: 20 } }, [
    instance
  ]);
  const journalPath = path.join(
    root,
    "data/StorageQuotaOperation",
    `${instance.instanceUuid}.json`
  );
  assert.equal(fs.statSync(journalPath).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(journalPath, "utf8")).version, 2);
  await operations.wait(instance);
  assert.equal(operations.hasPendingRecovery(instance), true);
  instance.config.startCommand = "incomplete-commit";
  instance.config.docker.env = ["TOKEN=new-secret"];
  faults.apply = undefined;
  operations.initialize(() => [instance]);
  await operations.wait(instance);
  assert.equal(instance.config.startCommand, "old-command");
  assert.deepEqual(instance.config.docker.env, ["TOKEN=" + "x".repeat(20000)]);
  assert.equal(instance.info.storageQuota.state, "ready");
  assert.equal(operations.hasPendingRecovery(instance), false);
});

test("monitoring cannot report an in-flight operation as needing recovery", async () => {
  const instance = createInstance();
  let releaseRefresh, releaseApply;
  quota.refreshInstanceUsage = () =>
    new Promise((resolve) => {
      releaseRefresh = resolve;
    });
  faults.apply = () =>
    new Promise((resolve) => {
      releaseApply = resolve;
    });
  operations.initialize(() => [instance]);
  operations.update(instance, { docker: { maxSpace: 20 } }, [instance]);
  releaseRefresh();
  await new Promise(setImmediate);
  assert.equal(operations.isApplying(instance), true);
  assert.equal(instance.info.storageQuota.state, "applying");
  while (!releaseApply) await new Promise(setImmediate);
  releaseApply();
  await operations.wait(instance);
  assert.equal(instance.info.storageQuota.state, "ready");
});

test("rollback rebuilds Docker command dispatch and lifecycle tasks", async () => {
  const { Instance, InstanceConfig, Dispatcher } = loadInstanceRuntime();
  for (const pty of [false, true]) {
    const config = new InstanceConfig();
    config.cwd = path.join(root, "xfs", `dispatch-${pty}`);
    fs.mkdirSync(config.cwd, { recursive: true });
    config.basePort = 25565;
    config.processType = "docker";
    config.terminalOption.pty = pty;
    Object.assign(config.docker, {
      maxSpace: 10,
      enableHardStorageQuota: true,
      storageQuotaProjectId: 200000
    });
    const instance = new Instance(`dispatch-${pty}`, config);
    await new Dispatcher().exec(instance);
    faults.clear = new Error("Partial quota clear failed");
    operations.update(
      instance,
      { processType: "general", docker: { enableHardStorageQuota: false } },
      [instance]
    );
    await operations.wait(instance);
    assert.equal(instance.config.processType, "docker");
    assert.equal(instance.config.docker.enableHardStorageQuota, true);
    assert.equal(instance.getPreset("start").constructor.name, "DockerStartCommand");
    assert.ok(
      instance.lifeCycleTaskManager.lifeCycleTask.some(
        (task) => task.constructor.name === "DockerStatsTask"
      )
    );
    assert.equal(operations.hasPendingRecovery(instance), false);
  }
});

test("rollback of a running quota resize preserves its existing lifecycle tasks", async () => {
  const { Instance, InstanceConfig, Dispatcher } = loadInstanceRuntime();
  const config = new InstanceConfig();
  config.cwd = path.join(root, "xfs/running");
  fs.mkdirSync(config.cwd, { recursive: true });
  config.basePort = 25565;
  config.processType = "docker";
  Object.assign(config.docker, { maxSpace: 10, enableHardStorageQuota: true });
  const instance = new Instance("running", config);
  await new Dispatcher().exec(instance);
  instance.status(Instance.STATUS_RUNNING);
  const tasks = [...instance.lifeCycleTaskManager.lifeCycleTask];
  const dispatch = mock.method(instance, "forceExec", async () => {
    throw new Error("Lifecycle tasks must not be replaced");
  });
  faults.apply = async (size) => {
    if (size === 20) throw new Error("Apply failed");
  };
  operations.update(instance, { docker: { maxSpace: 20 } }, [instance]);
  await operations.wait(instance);
  assert.equal(instance.config.docker.maxSpace, 10);
  assert.equal(operations.hasPendingRecovery(instance), false);
  assert.equal(dispatch.mock.callCount(), 0);
  assert.deepEqual(instance.lifeCycleTaskManager.lifeCycleTask, tasks);
});

test("a combined running quota and bandwidth update restores both when quota application fails", async () => {
  const { Instance, InstanceConfig } = loadInstanceRuntime();
  const config = new InstanceConfig();
  config.cwd = path.join(root, "xfs/live-bandwidth");
  fs.mkdirSync(config.cwd, { recursive: true });
  config.basePort = 25565;
  config.processType = "docker";
  Object.assign(config.docker, { maxSpace: 10, enableHardStorageQuota: true, uploadSpeedLimit: 1250, sharedUploadSpeedLimit: 0 });
  const instance = new Instance("live-bandwidth", config);
  instance.status(Instance.STATUS_RUNNING);
  const rates = [];
  instance.process = { updateBandwidth: async (docker) => { rates.push(docker.uploadSpeedLimit); } };
  faults.apply = async (size) => { if (size === 20) throw new Error("Injected quota failure"); };
  operations.update(instance, { docker: { maxSpace: 20, uploadSpeedLimit: 2500 } }, [instance]);
  await operations.wait(instance);
  assert.deepEqual(rates, [2500, 1250]);
  assert.equal(instance.config.docker.uploadSpeedLimit, 1250);
  assert.equal(instance.config.docker.maxSpace, 10);
  assert.equal(operations.hasPendingRecovery(instance), false);
});

test("starting, stopping and busy instances cannot accept quota jobs", () => {
  const instance = createInstance();
  for (const status of [-1, 1, 2]) {
    instance.status = () => status;
    assert.throws(
      () => operations.update(instance, { docker: { maxSpace: 20 } }, [instance]),
      /stopped or running/
    );
    assert.equal(instance.config.docker.maxSpace, 10);
    assert.equal(operations.isApplying(instance), false);
    assert.deepEqual(journalIds(), []);
  }
});

test("clearing a distinct pool restores the default directory for an empty stopped instance", async () => {
  const instance = createInstance("instance1", { storagePoolId: "pool" });
  instance.config.cwd = path.join(root, "xfs/pool", instance.instanceUuid);
  fs.mkdirSync(instance.config.cwd, { recursive: true });
  operations.update(instance, { docker: { storagePoolId: "" } }, [instance]);
  await operations.wait(instance);
  assert.equal(instance.config.docker.storagePoolId, "");
  assert.equal(instance.config.cwd, path.join(root, "xfs", instance.instanceUuid));
  assert.equal(instance.info.storageQuota.state, "ready");
});

test("clearing a pool never detaches a directory containing instance files", async () => {
  const instance = createInstance("instance1", { storagePoolId: "pool" });
  instance.config.cwd = path.join(root, "xfs/pool", instance.instanceUuid);
  fs.mkdirSync(instance.config.cwd, { recursive: true });
  fs.writeFileSync(path.join(instance.config.cwd, "world.dat"), "saved world");
  const previousCwd = instance.config.cwd;
  operations.update(instance, { docker: { storagePoolId: "" } }, [instance]);
  await operations.wait(instance);
  assert.equal(instance.config.docker.storagePoolId, "pool");
  assert.equal(instance.config.cwd, previousCwd);
  assert.equal(fs.readFileSync(path.join(previousCwd, "world.dat"), "utf8"), "saved world");
  assert.equal(instance.info.storageQuota.state, "error");
});

test("clearing a pool cannot keep an explicitly chosen directory inside it", () => {
  const instance = createInstance("instance1", { storagePoolId: "pool" });
  instance.config.cwd = path.join(root, "xfs/pool", instance.instanceUuid);
  assert.throws(
    () =>
      operations.update(
        instance,
        {
          cwd: path.join(root, "xfs/pool/another-directory"),
          docker: { storagePoolId: "" }
        },
        [instance]
      ),
    /outside the current storage pool/
  );
  assert.equal(instance.config.docker.storagePoolId, "pool");
  assert.deepEqual(journalIds(), []);
});

test("startup rechecks quota work after asynchronous directory creation", async () => {
  const { Instance } = loadInstanceRuntime();
  const AbsStartCommand = require("../src/entity/commands/start.ts").default;
  const quotaOperations = require("../src/service/storage_quota_operation_service.ts").default;
  const fsExtra = require("fs-extra");
  const instance = createInstance();
  fs.rmdirSync(instance.config.cwd);
  let releaseDirectory, enteredDirectory;
  const directoryEntered = new Promise((resolve) => (enteredDirectory = resolve));
  const directoryReleased = new Promise((resolve) => (releaseDirectory = resolve));
  mock.method(fsExtra, "mkdirs", async () => {
    enteredDirectory();
    await directoryReleased;
  });
  let applying = false;
  mock.method(quotaOperations, "isApplying", () => applying);
  mock.method(quotaOperations, "hasPendingRecovery", () => false);
  let started = false,
    failed;
  instance.failure = (error) => (failed = error);
  instance.status = () => Instance.STATUS_STOP;
  const command = new (class extends AbsStartCommand {
    async createProcess() {
      started = true;
    }
  })();
  const starting = command.exec(instance);
  await directoryEntered;
  applying = true;
  releaseDirectory();
  await starting;
  assert.equal(started, false);
  assert.match(failed.message, /in progress/);
});

test("an in-flight Docker startup cannot overwrite a newer quota save", async () => {
  const { Instance } = loadInstanceRuntime();
  const { SetupDockerContainer } = require("../src/service/docker_process_service.ts");
  const service = require("../src/service/storage_quota_service.ts").default;
  const instance = createInstance();
  let status = Instance.STATUS_STARTING;
  instance.status = () => status;
  instance.forceExec = async () => {
    throw new Error("Stop before Docker access");
  };
  let releaseCheck, enteredCheck;
  const checkEntered = new Promise((resolve) => (enteredCheck = resolve));
  const checkReleased = new Promise((resolve) => (releaseCheck = resolve));
  mock.method(service, "resolveDockerLocalWorkspace", () => instance.config.cwd);
  mock.method(service, "resolveDockerHostWorkspace", () => instance.config.cwd);
  mock.method(service, "checkStoragePool", async () => {
    enteredCheck();
    await checkReleased;
  });
  mock.method(service, "ensureDockerHardQuota", (...args) => quota.ensureDockerHardQuota(...args));
  const starting = assert.rejects(
    new SetupDockerContainer(instance).onStart(),
    /Stop before Docker access/
  );
  await checkEntered;
  try {
    assert.throws(
      () => operations.update(instance, { docker: { maxSpace: 20 } }, [instance]),
      /stopped or running/
    );
  } finally {
    releaseCheck();
  }
  await starting;
  assert.equal(applied.get(instance.instanceUuid), 10);
  status = Instance.STATUS_RUNNING;
  operations.update(instance, { docker: { maxSpace: 20 } }, [instance]);
  await operations.wait(instance);
  assert.equal(applied.get(instance.instanceUuid), 20);
  assert.equal(instance.config.docker.maxSpace, 20);
  assert.equal(instance.info.storageQuota.state, "ready");
});
