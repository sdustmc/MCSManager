const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test, beforeEach, afterEach, mock } = require("node:test");
const ctx = require("./helpers/quota_context");
const { Instance, InstanceConfig, Dispatcher, routerApp, httpRouter } =
  ctx.loadInstanceRuntime(true);
const subsystem = require("../src/service/system_instance.ts").default;
const operations = require("../src/service/storage_quota_operation_service.ts").default;
const quota = require("../src/service/storage_quota_service.ts").default;
const { DefaultDocker } = require("../src/service/docker_service.ts");
const {
  DockerProcessAdapter,
  SetupDockerContainer
} = require("../src/service/docker_process_service.ts");
const takeover = require("../src/service/takeover_container.ts").default;
const { QuickInstallTask } = require("../src/service/async_task_service/quick_install.ts");
const InstallCommand = require("../src/entity/commands/general/general_install.ts").default;
const FileManager = require("../src/service/system_file.ts").default;
const FileWriter = require("../src/entity/file_writer.ts").default;
const { missionPassport } = require("../src/service/mission_passport.ts");
const uploadManager = require("../src/service/upload_manager.ts").default;
const { uploadFileCheckMiddleware } = require("../src/middlewares/precheck.ts");

beforeEach(() => {
  fs.rmSync(path.join(ctx.root, "data/StorageQuotaOperation"), { recursive: true, force: true });
  subsystem.instances.clear();
  missionPassport.missions.clear();
  mock.method(ctx.logger, "error", () => {});
  mock.method(ctx.logger, "warn", () => {});
  mock.method(ctx.logger, "info", () => {});
});
afterEach(async () => {
  await uploadManager.exit();
  subsystem.instances.clear();
  mock.restoreAll();
});

function instance(id) {
  const config = new InstanceConfig();
  config.cwd = path.join(ctx.root, "xfs", id);
  fs.mkdirSync(config.cwd, { recursive: true });
  config.basePort = 25565;
  config.processType = "docker";
  Object.assign(config.docker, { enableHardStorageQuota: true, maxSpace: 0.001 });
  const result = new Instance(id, config);
  subsystem.instances.set(id, result);
  return result;
}

function fakeDocker(instances, failure) {
  const killed = [],
    attached = [];
  mock.method(DefaultDocker.prototype, "listContainers", async () =>
    instances.map((item) => ({
      Id: item.instanceUuid,
      State: "running",
      Labels: { "mcsmanager.instance.uuid": item.instanceUuid }
    }))
  );
  mock.method(DefaultDocker.prototype, "getContainer", (id) => ({
    id,
    async kill() {
      killed.push(id);
    },
    async remove() {
      killed.push(id);
    }
  }));
  mock.method(DockerProcessAdapter.prototype, "start", async function (_, container) {
    if (container.id === failure) throw new Error("Attach failed");
    attached.push(container.id);
  });
  for (const item of instances)
    mock.method(item, "started", function (process) {
      this.process = process;
      this.status(Instance.STATUS_RUNNING);
    });
  return { killed, attached };
}

test("pending quota recovery does not kill containers or block takeover of healthy instances", async () => {
  const recovering = instance("recovering"),
    healthy = instance("healthy");
  const { killed, attached } = fakeDocker([recovering, healthy]);
  mock.method(operations, "isApplying", (item) => item === recovering);
  mock.method(operations, "hasPendingRecovery", (item) => item === recovering);
  await takeover();
  assert.deepEqual(attached, ["recovering", "healthy"]);
  assert.deepEqual(killed, []);
  assert.equal(recovering.status(), Instance.STATUS_RUNNING);
  assert.equal(healthy.status(), Instance.STATUS_RUNNING);
});

test("a failed attach leaves its live container protected and continues other takeovers", async () => {
  const broken = instance("broken"),
    healthy = instance("healthy");
  await new Dispatcher().exec(broken);
  const { killed, attached } = fakeDocker([broken, healthy], "broken");
  await takeover();
  assert.deepEqual(killed, []);
  assert.deepEqual(attached, ["healthy"]);
  assert.equal(broken.status(), Instance.STATUS_BUSY);
  assert.equal(broken.lock, false);
  assert.equal(healthy.status(), Instance.STATUS_RUNNING);
  await assert.rejects(subsystem.removeInstance(broken.instanceUuid, true));
  broken.startTimestamp = 0;
  await broken.execPreset("kill");
  assert.equal(broken.status(), Instance.STATUS_STOP);
  assert.equal(broken.process, undefined);
  assert.ok(killed.includes("broken"));
});

test("failure to connect to an existing container never kills it", async () => {
  let killed = false;
  const container = {
    id: "existing",
    modem: {
      dial(_, callback) {
        callback(new Error("Disconnected"));
      }
    },
    async kill() {
      killed = true;
    }
  };
  const adapter = new DockerProcessAdapter(new SetupDockerContainer(instance("adapter")));
  await assert.rejects(adapter.start({ isTty: false, h: 24, w: 80 }, container), /Disconnected/);
  assert.equal(killed, false);
});

test("expired containers remain subject to expiry after takeover establishes control", async () => {
  const item = instance("expired");
  item.config.endTime = Date.now() - 1;
  const { attached } = fakeDocker([item]);
  const commands = [];
  mock.method(item, "execPreset", async (command) => {
    assert.ok(item.process);
    commands.push(command);
  });
  await takeover();
  assert.deepEqual(attached, ["expired"]);
  assert.deepEqual(commands, ["kill"]);
});

test("reinstallation empties the workspace while preserving its root inode", async () => {
  const item = instance("reinstall");
  const rootInode = fs.statSync(item.config.cwd).ino;
  fs.writeFileSync(path.join(item.config.cwd, "old-world.dat"), "old world");
  let installed = false;
  mock.method(QuickInstallTask.prototype, "start", async () => {
    installed = true;
    assert.equal(fs.statSync(item.config.cwd).ino, rootInode);
    assert.deepEqual(fs.readdirSync(item.config.cwd), []);
  });
  mock.method(QuickInstallTask.prototype, "wait", async () => {});
  await new InstallCommand().exec(item, {
    targetLink: "https://example.invalid/server.zip",
    setupInfo: { processType: "docker" }
  });
  assert.equal(installed, true);
  assert.equal(item.status(), Instance.STATUS_STOP);
});

test("deleting the file-manager root preserves the quota directory inode", async () => {
  const item = instance("empty");
  const inode = fs.statSync(item.config.cwd).ino;
  fs.writeFileSync(path.join(item.config.cwd, "world.dat"), "data");
  await new FileManager(item.config.cwd).delete(".");
  assert.equal(fs.statSync(item.config.cwd).ino, inode);
  assert.deepEqual(fs.readdirSync(item.config.cwd), []);
});

test("reinstallation cannot discard files while a quota recovery record exists", async () => {
  const item = instance("recovery-install");
  const world = path.join(item.config.cwd, "world.dat");
  fs.writeFileSync(world, "saved world");
  ctx.Storage.store("StorageQuotaOperation", item.instanceUuid, {});
  await assert.rejects(
    new InstallCommand().exec(item, { setupInfo: { processType: "docker" } }),
    /recovery/
  );
  assert.equal(fs.readFileSync(world, "utf8"), "saved world");
  assert.equal(item.status(), Instance.STATUS_STOP);
});

test("new preset installations retain quota settings before any download starts", () => {
  const task = new QuickInstallTask("New server", "https://example.invalid/server.jar", {
    processType: "docker",
    startCommand: "java -jar server.jar",
    docker: { maxSpace: 1, enableHardStorageQuota: true }
  });
  assert.equal(task.instance.config.docker.enableHardStorageQuota, true);
  assert.equal(task.instance.config.docker.maxSpace, 1);
  assert.equal(task.instance.config.processType, "docker");
  assert.throws(() => operations.assertWritable(task.instance));
});

for (const failure of [false, true]) {
  test(`installation verifies quota before downloading (${
    failure ? "failure" : "success"
  })`, async () => {
    const item = instance(`install-${failure}`);
    const events = [];
    mock.method(quota, "ensureDockerHardQuota", async (_, __, ___, options) => {
      events.push(options.reinitialize ? "initialize" : "verify");
      if (failure) throw new Error("Quota unavailable");
      item.config.docker.storageQuotaProjectId = 200000;
    });
    mock.method(quota, "readUsage", async () => ({
      state: "ready",
      usedBytes: 0,
      allocatedBytes: 1000000
    }));
    const task = new QuickInstallTask(
      "Server",
      "https://example.invalid/server.jar",
      { processType: "docker", startCommand: "java -jar server.jar" },
      item
    );
    task.on("error", () => {});
    mock.method(task, "download", async () => events.push("download"));
    await task.onStart();
    await new Promise(setImmediate);
    assert.deepEqual(events, failure ? ["initialize"] : ["initialize", "download", "verify"]);
    assert.equal(item.info.storageQuota.state, failure ? "error" : "ready");
    assert.equal(item.status(), Instance.STATUS_STOP);
  });
}

function quotaJob(item, fail = false) {
  let release, entered;
  const started = new Promise((resolve) => (entered = resolve));
  const blocked = new Promise((resolve) => (release = resolve));
  const service = {
    validateConfig: ctx.getStorageQuotaLimits,
    resolveDockerDiskWorkspace: (target) => target.absoluteCwdPath(),
    async inspectWorkspace() {
      entered();
      await blocked;
      if (fail) throw new Error("Quota preflight failed");
    },
    async checkStoragePool() {},
    async ensureDockerHardQuota(target) {
      target.config.docker.storageQuotaProjectId = 200000;
    },
    async readUsage() {
      return { state: "ready", usedBytes: 0, allocatedBytes: 1000000 };
    },
    setInstanceProvider() {},
    dispose() {}
  };
  const jobs = new ctx.Operations(service);
  mock.method(operations, "update", (...args) => jobs.update(...args));
  mock.method(operations, "isApplying", (target) => jobs.isApplying(target));
  return { jobs, release: () => release(), started };
}

async function beginUpload(item, key, size = 16) {
  missionPassport.registerMission(key, {
    name: "upload",
    start: Date.now(),
    end: Date.now() + 60000,
    parameter: { instanceUuid: item.instanceUuid, uploadDir: "." }
  });
  const request = {
    params: { key },
    query: { filename: `${key}.dat`, size: String(size), code: "UTF-8" },
    status: 200
  };
  const route = httpRouter.stack.find((layer) => layer.path === "/upload-new/:key");
  await route.stack[0](request);
  return request;
}

for (const failure of [false, true]) {
  test(`creation blocks uploads until quota succeeds (${
    failure ? "failure" : "success"
  })`, async () => {
    const item = ctx.createInstance(`upload-${failure}`, { maxSpace: 0.001 });
    subsystem.instances.set(item.instanceUuid, item);
    mock.method(subsystem, "createInstance", () => item);
    const job = quotaJob(item, failure);
    const responses = [];
    try {
      routerApp.listeners("instance/new")[0](
        {
          uuid: "request",
          event: "instance/new",
          socket: { emit: (_, packet) => responses.push(packet) }
        },
        item.config
      );
      assert.equal(responses[0].data.storageQuotaStatus, "applying");
      await job.started;
      const early = await beginUpload(item, `early-${failure}`);
      assert.equal(early.status, 500);
      assert.equal(fs.existsSync(path.join(item.config.cwd, `early-${failure}.dat`)), false);
      job.release();
      await job.jobs.wait(item);
      const later = await beginUpload(item, `later-${failure}`);
      assert.equal(later.status, failure ? 500 : 200);
      if (!failure) {
        const writer = uploadManager.get(later.body.data.id);
        await writer.write(0, Buffer.alloc(16, 1));
        assert.equal(fs.statSync(writer.path).size, 16);
      }
    } finally {
      job.release();
      await job.jobs.dispose();
    }
  });
}

test("multipart uploads are rejected before temporary files are received while quota is pending", async () => {
  const item = instance("multipart");
  item.info.storageQuota = { state: "applying" };
  missionPassport.registerMission("pending", {
    name: "upload",
    start: 0,
    end: Date.now() + 60000,
    parameter: { instanceUuid: item.instanceUuid }
  });
  let accepted = false;
  await assert.rejects(
    uploadFileCheckMiddleware(
      {
        origin: "http://localhost",
        url: "/upload/pending",
        request: { headers: { "content-type": "multipart/form-data" } }
      },
      async () => (accepted = true)
    )
  );
  assert.equal(accepted, false);
});

test("update commands cannot run before their hard quota is ready", async () => {
  const item = instance("update-before-ready");
  const UpdateCommand = require("../src/entity/commands/general/general_update.ts").default;
  const { InstanceUpdateAction } = require("../src/service/instance_update_action.ts");
  let started = false;
  mock.method(InstanceUpdateAction.prototype, "start", async () => (started = true));
  mock.method(InstanceUpdateAction.prototype, "wait", async () => {});
  await assert.rejects(new UpdateCommand().exec(item));
  assert.equal(started, false);
  assert.equal(item.status(), Instance.STATUS_STOP);
});

test("mod downloads cannot bypass a missing hard quota", async () => {
  const item = instance("mod-before-ready");
  const { modService } = require("../src/service/mod_service.ts");
  let downloaded = false;
  mock.method(modService, "installMod", async () => (downloaded = true));
  const replies = [];
  const request = {
    uuid: "mod",
    event: "instance/mods/install",
    socket: { emit: (_, packet) => replies.push(packet) }
  };
  await routerApp.listeners("instance/mods/install")[0](request, {
    instanceUuid: item.instanceUuid,
    url: "https://example.invalid/mod.jar",
    fileName: "mod.jar",
    type: "mod"
  });
  assert.equal(downloaded, false);
  assert.equal(replies[0].status, 500);
});

test("an existing upload cannot write while a quota operation changes its directory", async () => {
  const item = instance("old-writer");
  item.config.docker.storageQuotaProjectId = 200000;
  item.info.storageQuota = { state: "ready" };
  const writer = new FileWriter(
    item,
    "chunk.dat",
    16,
    false,
    "UTF-8",
    path.join(item.config.cwd, "chunk.dat")
  );
  try {
    await writer.init();
    item.info.storageQuota = { state: "applying" };
    await assert.rejects(writer.write(0, Buffer.alloc(16)), /quota/i);
    item.info.storageQuota = { state: "ready" };
    item.config.cwd = path.join(ctx.root, "moved");
    await assert.rejects(writer.write(0, Buffer.alloc(16)));
    assert.deepEqual(writer.received, []);
  } finally {
    await writer.stop();
  }
});
