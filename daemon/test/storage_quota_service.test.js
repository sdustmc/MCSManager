const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { beforeEach, afterEach, test, mock } = require("node:test");
const {
  root,
  QuotaService,
  Operations,
  createInstance,
  config,
  GIB,
  logger
} = require("./helpers/quota_context");

let quota, records, commands, options, faults;
beforeEach(() => {
  fs.rmSync(path.join(root, "data"), { recursive: true, force: true });
  fs.rmSync(path.join(root, "managed"), { recursive: true, force: true });
  fs.rmSync(path.join(root, "xfs"), { recursive: true, force: true });
  fs.mkdirSync(path.join(root, "managed"), { recursive: true });
  records = new Map();
  commands = [];
  faults = {};
  config.storagePools = [];
  mock.method(logger, "error", () => {});
  options = {
    projectsPath: path.join(root, "managed/projects"),
    projidPath: path.join(root, "managed/projid"),
    transactionPath: path.join(root, "managed/transaction.json"),
    lockPath: path.join(root, "managed/quota-lock"),
    async runCommand(command, args, timeout, signal) {
      if (signal.aborted) throw new Error("Command aborted");
      commands.push({ command, args });
      if (command === "findmnt") {
        const target = args[args.indexOf("--target") + 1];
        const unrelated = target.includes("non-xfs");
        return {
          stdout: JSON.stringify({
            filesystems: [
              {
                target: path.join(root, unrelated ? "non-xfs" : "xfs"),
                fstype: unrelated ? "ext4" : "xfs",
                options: unrelated ? "rw" : "rw,prjquota"
              }
            ]
          }),
          stderr: ""
        };
      }
      const instruction = args[args.indexOf("-c") + 1];
      let stdout = "";
      if (args.includes("-V")) return { stdout: "xfs_quota test", stderr: "" };
      if (instruction === "state -p")
        stdout = `Accounting: ON\nEnforcement: ${faults.enforcementOff ? "OFF" : "ON"}\n`;
      else if (instruction.startsWith("report")) {
        if (faults.report) throw new Error("Quota read failed");
        const inodeReport = instruction.endsWith("-i");
        stdout = Array.from(
          records,
          ([id, record]) =>
            `#${id} ${inodeReport ? record.inodes : record.used / 1024} 0 ${
              inodeReport ? record.inodeLimit : record.hard / 1024
            } 00 [------]`
        ).join("\n");
      } else {
        const projectName = instruction.split(" ").at(-1);
        const projid = fs.readFileSync(options.projidPath, "utf8");
        const line = projid.split("\n").find((entry) => entry.startsWith(projectName + ":"));
        assert.ok(line, "commands must reference a registered project");
        const id = Number(line.split(":")[1]);
        if (!records.has(id)) records.set(id, { used: 0, hard: 0, inodes: 0, inodeLimit: 0 });
        const record = records.get(id);
        if (instruction.startsWith("project -c")) {
          const workspace = fs
            .readFileSync(options.projectsPath, "utf8")
            .split("\n")
            .find((entry) => entry.startsWith(id + ":"))
            .slice(String(id).length + 1);
          const lines = [`Checking project ${projectName} (path ${workspace})...`];
          if (!record.inherits || faults.ignoreSetup)
            lines.push(`${workspace} - project inheritance flag is not set`);
          lines.push(
            `Processed 1 (${options.projectsPath} and cmdline) paths for project ${projectName} with recursion depth limited (0).`
          );
          stdout = lines.join("\n") + "\n";
        }
        if (instruction.startsWith("project -s")) {
          if (faults.setup) throw new Error("Project setup failed");
          record.inherits = true;
        }
        if (instruction.startsWith("project -C")) {
          record.inherits = false;
          if (faults.clear)
            throw new Error("Project clear timed out after changing directory flags");
        }
        if (instruction.startsWith("limit") && !faults.ignoreLimit) {
          const hard = instruction.match(/bhard=(\d+)(k?)/);
          record.hard = Number(hard[1]) * (hard[2] ? 1024 : 1);
          record.inodeLimit = Number(instruction.match(/ihard=(\d+)/)[1]);
        }
      }
      return { stdout, stderr: "" };
    }
  };
  quota = new QuotaService(options);
});
afterEach(() => {
  quota.dispose();
  mock.restoreAll();
});

test("applies and verifies block and inode limits without touching system quota files", async () => {
  const instance = createInstance("instance1", { storageQuotaInodes: 1000 });
  await quota.ensureDockerHardQuota(instance, instance.config.cwd, 10);
  assert.equal(instance.config.docker.storageQuotaProjectId, 200000);
  assert.equal(records.get(200000).hard, 11 * GIB);
  assert.equal(records.get(200000).inodeLimit, 1000);
  assert.match(fs.readFileSync(options.projectsPath, "utf8"), /200000:/);
  assert.equal(fs.existsSync(options.transactionPath), false);
  const usage = await quota.readUsage(instance);
  assert.equal(usage.state, "ready");
  assert.equal(usage.allocatedBytes, 10 * GIB);
  assert.equal(usage.hardLimitBytes, 11 * GIB);
});

test("changing an existing limit avoids recursively initializing the directory again", async () => {
  const instance = createInstance();
  await quota.ensureDockerHardQuota(instance, instance.config.cwd, 10);
  await quota.ensureDockerHardQuota(instance, instance.config.cwd, 20);
  assert.equal(records.get(200000).hard, 22 * GIB);
  assert.equal(
    commands.filter((command) => command.args.some((arg) => arg.startsWith("project -s"))).length,
    1
  );
});

test("zero buffer enforces the configured capacity exactly", async () => {
  const instance = createInstance("instance1", { storageQuotaBufferPercent: 0 });
  await quota.ensureDockerHardQuota(instance, instance.config.cwd, 10);
  assert.equal(records.get(200000).hard, 10 * GIB);
});

test("rejects shrinking below used blocks or inodes without changing the limits", async () => {
  const instance = createInstance("instance1", { storageQuotaInodes: 1000 });
  await quota.ensureDockerHardQuota(instance, instance.config.cwd, 10);
  records.get(200000).used = 5 * GIB;
  await assert.rejects(
    quota.ensureDockerHardQuota(instance, instance.config.cwd, 4),
    /smaller than the current usage/
  );
  assert.equal(records.get(200000).hard, 11 * GIB);
  records.get(200000).inodes = 500;
  instance.config.docker.storageQuotaInodes = 100;
  await assert.rejects(
    quota.ensureDockerHardQuota(instance, instance.config.cwd, 10),
    /smaller than the current usage/
  );
  assert.equal(records.get(200000).inodeLimit, 1000);
});

test("requires enforcement as well as quota accounting", async () => {
  const instance = createInstance();
  faults.enforcementOff = true;
  await assert.rejects(quota.inspectWorkspace(instance.config.cwd), /accounting and enforcement/);
  assert.equal(fs.existsSync(options.projidPath), false);
});

test("rejects symlinks and overlapping quota directories", async () => {
  const instance = createInstance();
  const link = path.join(root, "xfs/link");
  fs.symlinkSync(instance.config.cwd, link);
  await assert.rejects(quota.inspectWorkspace(link), /dedicated directory/);
  fs.writeFileSync(options.projectsPath, `123:${path.join(root, "xfs")}\n`);
  fs.writeFileSync(options.projidPath, "other:123\n");
  await assert.rejects(quota.inspectWorkspace(instance.config.cwd), /overlaps/);
});

test("does not reuse an unregistered project ID that still owns blocks", async () => {
  records.set(200000, { used: GIB, hard: 0, inodes: 1, inodeLimit: 0 });
  const instance = createInstance();
  await quota.ensureDockerHardQuota(instance, instance.config.cwd, 10);
  assert.equal(instance.config.docker.storageQuotaProjectId, 200001);
});

test("verifies that the kernel accepted the requested limit", async () => {
  const instance = createInstance();
  faults.ignoreLimit = true;
  await assert.rejects(quota.ensureDockerHardQuota(instance, instance.config.cwd, 10), /readback/);
  assert.equal(instance.config.docker.storageQuotaProjectId, undefined);
});

test("batch-caches reports for multiple instances on one filesystem", async () => {
  const first = createInstance("first");
  const second = createInstance("second");
  await quota.ensureDockerHardQuota(first, first.config.cwd, 10);
  await quota.ensureDockerHardQuota(second, second.config.cwd, 10);
  quota.clearUsageCache();
  commands.length = 0;
  await Promise.all([quota.readUsage(first), quota.readUsage(second)]);
  await quota.readUsage(first);
  assert.equal(commands.filter((command) => command.args.includes("report -p -n -N -b")).length, 1);
  assert.equal(commands.filter((command) => command.args.includes("report -p -n -N -i")).length, 1);
});

test("usage errors retain the previous measurement and expose an unknown state", async () => {
  const instance = createInstance();
  instance.info.storageUsage = 1234;
  faults.report = true;
  await quota.refreshInstanceUsage(instance);
  assert.equal(instance.info.storageUsage, 1234);
  assert.equal(instance.info.storageQuota.state, "unknown");
});

test("clearing a project removes both inode and block limits and its registration", async () => {
  const instance = createInstance("instance1", { storageQuotaInodes: 1000 });
  await quota.ensureDockerHardQuota(instance, instance.config.cwd, 10);
  await quota.deleteDockerHardQuotaIfManaged(instance, instance.config.cwd);
  assert.equal(records.get(200000).hard, 0);
  assert.equal(records.get(200000).inodeLimit, 0);
  assert.equal(instance.config.docker.storageQuotaProjectId, undefined);
  assert.equal(fs.readFileSync(options.projidPath, "utf8"), "");
});

test("recovers an interrupted pair of project files before accepting more operations", async () => {
  fs.writeFileSync(
    options.transactionPath,
    JSON.stringify({
      version: 1,
      previousProjectsText: "",
      previousProjidText: "",
      nextProjectsText: "123:/data/one\n",
      nextProjidText: "one:123\n"
    })
  );
  await quota.recoverPendingProjectFileTransaction();
  assert.equal(fs.readFileSync(options.projectsPath, "utf8"), "123:/data/one\n");
  assert.equal(fs.readFileSync(options.projidPath, "utf8"), "one:123\n");
  assert.equal(fs.existsSync(options.transactionPath), false);
  assert.equal(commands.length, 0);
});

test("rejects removing a storage pool while an instance is assigned to it", async () => {
  config.storagePools = [
    { id: "pool", name: "Pool", path: path.join(root, "xfs"), reserveGiB: 10 }
  ];
  const instance = createInstance("instance1", { storagePoolId: "pool" });
  await assert.rejects(quota.validateStoragePools([], [instance]), /cannot be removed/);
});

test("rejects multiple pool definitions on the same filesystem", async () => {
  const instance = createInstance();
  await assert.rejects(
    quota.validateStoragePools(
      [
        { id: "one", name: "One", path: path.join(root, "xfs"), reserveGiB: 0 },
        { id: "two", name: "Two", path: instance.config.cwd, reserveGiB: 0 }
      ],
      []
    ),
    /different XFS filesystem/
  );
});

test("protects reserved storage capacity from new allocations", async () => {
  const instance = createInstance("instance1", { storagePoolId: "pool" });
  config.storagePools = [
    { id: "pool", name: "Pool", path: path.join(root, "xfs"), reserveGiB: 1048576 }
  ];
  await assert.rejects(quota.checkStoragePool(instance, []), /insufficient/);
});

test("usage detects enforcement being disabled after allocation", async () => {
  const instance = createInstance();
  await quota.ensureDockerHardQuota(instance, instance.config.cwd, 10);
  faults.enforcementOff = true;
  const usage = await quota.readUsage(instance, true);
  assert.equal(usage.state, "error");
  assert.match(usage.error, /accounting and enforcement/);
  assert.equal(usage.hardLimitBytes, 11 * GIB);
});

test("usage exposes an externally changed hard limit", async () => {
  const instance = createInstance();
  await quota.ensureDockerHardQuota(instance, instance.config.cwd, 10);
  records.get(200000).hard = 4 * GIB;
  const usage = await quota.readUsage(instance, true);
  assert.equal(usage.state, "error");
  assert.equal(usage.hardLimitBytes, 4 * GIB);
  assert.equal(usage.allocatedBytes, 10 * GIB);
});

test("storage pool accounting includes foreign kernel projects", async () => {
  const instance = createInstance();
  records.set(123, { used: GIB, hard: 7 * GIB, inodes: 2, inodeLimit: 100 });
  await quota.ensureDockerHardQuota(instance, instance.config.cwd, 10);
  instance.config.docker.storagePoolId = "pool";
  config.storagePools = [{ id: "pool", name: "Pool", path: path.join(root, "xfs"), reserveGiB: 0 }];
  const [pool] = await quota.listStoragePools([instance]);
  assert.equal(pool.error, undefined);
  assert.equal(pool.allocatedBytes, 18 * GIB);
  const [excludingCurrent] = await quota.listStoragePools([instance], instance);
  assert.equal(excludingCurrent.allocatedBytes, 7 * GIB);
});

test("does not reuse an unregistered project that still has quota usage", async () => {
  const instance = createInstance();
  records.set(200000, { used: GIB, hard: 2 * GIB, inodes: 2, inodeLimit: 100 });
  await quota.ensureDockerHardQuota(instance, instance.config.cwd, 10);
  assert.equal(instance.config.docker.storageQuotaProjectId, 200001);
  assert.equal(records.get(200000).hard, 2 * GIB);
});

test("pool allocation is rechecked inside the operation lock", async () => {
  const first = createInstance("first", { storagePoolId: "pool" });
  const second = createInstance("second", { storagePoolId: "pool" });
  const all = [first, second];
  quota.setInstanceProvider(() => all);
  const checks = [];
  mock.method(quota, "checkStoragePool", async (instance, instances) => {
    assert.equal(instances, all);
    checks.push(instance.instanceUuid);
    if (instance === second) {
      assert.equal(records.get(200000).hard, 11 * GIB);
      throw new Error("Insufficient capacity");
    }
  });
  const results = await Promise.allSettled(
    all.map((instance) => quota.ensureDockerHardQuota(instance, instance.config.cwd, 10))
  );
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.deepEqual(checks, ["first", "second"]);
  assert.equal(records.size, 1);
});

test("a failed project clear rebuilds inheritance before finishing rollback", async () => {
  const instance = createInstance();
  await quota.ensureDockerHardQuota(instance, instance.config.cwd, 10);
  faults.clear = true;
  const operations = new Operations(quota);
  try {
    operations.update(instance, { docker: { enableHardStorageQuota: false } }, [instance]);
    await operations.wait(instance);
    assert.equal(instance.info.storageQuota.state, "error");
    assert.equal(instance.config.docker.enableHardStorageQuota, true);
    assert.equal(records.get(200000).hard, 11 * GIB);
    assert.equal(records.get(200000).inherits, true);
    assert.equal(
      commands.filter((command) => command.args.some((arg) => arg.startsWith("project -s"))).length,
      2
    );
    assert.equal(operations.hasPendingRecovery(instance), false);
  } finally {
    await operations.dispose();
  }
});

test("failed inheritance recovery retains its journal until repair succeeds", async () => {
  const instance = createInstance();
  await quota.ensureDockerHardQuota(instance, instance.config.cwd, 10);
  faults.clear = true;
  faults.setup = true;
  const operations = new Operations(quota);
  try {
    operations.update(instance, { docker: { enableHardStorageQuota: false } }, [instance]);
    await operations.wait(instance);
    assert.equal(records.get(200000).inherits, false);
    assert.equal(operations.hasPendingRecovery(instance), true);
    faults.clear = faults.setup = false;
    operations.retry(instance, [instance]);
    await operations.wait(instance);
    assert.equal(records.get(200000).inherits, true);
    assert.equal(instance.info.storageQuota.state, "ready");
    assert.equal(operations.hasPendingRecovery(instance), false);
  } finally {
    await operations.dispose();
  }
});

test("usage refresh preserves a job state created while its read is pending", async () => {
  for (const failure of [false, true]) {
    const instance = createInstance();
    const initial = { state: "ready", usedBytes: 1 };
    instance.info.storageQuota = initial;
    instance.info.storageUsage = 1;
    let resolve, reject;
    const read = mock.method(
      quota,
      "readUsage",
      () =>
        new Promise((done, fail) => {
          resolve = done;
          reject = fail;
        })
    );
    const refresh = quota.refreshInstanceUsage(instance);
    const applying = { state: "applying", usedBytes: 1 };
    instance.info.storageQuota = applying;
    if (failure) reject(new Error("Stale read failed"));
    else resolve({ state: "ready", usedBytes: 999, allocatedBytes: 10 * GIB });
    await refresh;
    assert.equal(instance.info.storageQuota, applying);
    assert.equal(instance.info.storageUsage, 1);
    read.mock.restore();
  }
});

test("storage pools validate and allocate in the mapped host workspace", async () => {
  const oldDefault = config.defaultInstancePath;
  const oldMapping = process.env.MCSM_DOCKER_WORKSPACE_PATH;
  try {
    const local = path.join(root, "xfs/local");
    const host = path.join(root, "xfs/host");
    config.defaultInstancePath = local;
    process.env.MCSM_DOCKER_WORKSPACE_PATH = host;
    for (const useRoot of [false, true]) {
      const pool = {
        id: "pool",
        name: "Pool",
        path: useRoot ? local : path.join(local, "pool"),
        reserveGiB: 0
      };
      const hostPool = useRoot ? host : path.join(host, "pool");
      const instance = createInstance(`mapped-${useRoot}`, {
        storagePoolId: "pool",
        maxSpace: 0.001
      });
      instance.config.cwd = path.join(pool.path, instance.instanceUuid);
      const hostWorkspace = path.join(hostPool, instance.instanceUuid);
      fs.mkdirSync(instance.config.cwd, { recursive: true });
      fs.mkdirSync(hostWorkspace, { recursive: true });
      config.storagePools = [];
      config.storagePools = await quota.validateStoragePools([pool], [instance]);
      assert.equal(quota.resolveDockerDiskWorkspace(instance), hostWorkspace);
      assert.equal(quota.resolvePoolDirectory("pool", instance.instanceUuid), instance.config.cwd);
      await quota.checkStoragePool(instance, [instance]);
      const [statistics] = await quota.listStoragePools([instance]);
      assert.equal(statistics.path, pool.path);
      assert.equal(statistics.error, undefined);
      assert.ok(
        commands.some((command) => command.command === "findmnt" && command.args.includes(hostPool))
      );
    }
  } finally {
    config.defaultInstancePath = oldDefault;
    if (oldMapping === undefined) delete process.env.MCSM_DOCKER_WORKSPACE_PATH;
    else process.env.MCSM_DOCKER_WORKSPACE_PATH = oldMapping;
  }
});

test("a rejected shrink above allocated usage restores the quota and allows expansion", async () => {
  const instance = createInstance();
  await quota.ensureDockerHardQuota(instance, instance.config.cwd, 10);
  records.get(200000).used = 10.5 * GIB;
  const operations = new Operations(quota);
  try {
    operations.update(instance, { docker: { maxSpace: 9 } }, [instance]);
    await operations.wait(instance);
    assert.equal(instance.info.storageQuota.state, "error");
    assert.equal(instance.config.docker.maxSpace, 10);
    assert.equal(records.get(200000).hard, 11 * GIB);
    assert.equal(operations.hasPendingRecovery(instance), false);
    operations.update(instance, { docker: { maxSpace: 20 } }, [instance]);
    await operations.wait(instance);
    assert.equal(instance.info.storageQuota.state, "ready");
    assert.equal(instance.config.docker.maxSpace, 20);
    assert.equal(records.get(200000).hard, 22 * GIB);
  } finally {
    await operations.dispose();
  }
});

test("partial quota removal restores enforcement despite buffered usage and a full pool", async () => {
  const instance = createInstance("instance1", { storageQuotaInodes: 1000 });
  await quota.ensureDockerHardQuota(instance, instance.config.cwd, 10);
  const record = records.get(200000);
  record.used = 10.5 * GIB;
  record.inodes = 1001;
  instance.config.docker.storagePoolId = "pool";
  config.storagePools = [
    { id: "pool", name: "Pool", path: path.join(root, "xfs"), reserveGiB: 1048576 }
  ];
  faults.clear = true;
  const operations = new Operations(quota);
  try {
    operations.update(instance, { docker: { enableHardStorageQuota: false } }, [instance]);
    await operations.wait(instance);
    assert.equal(instance.config.docker.enableHardStorageQuota, true);
    assert.equal(record.hard, 11 * GIB);
    assert.equal(record.inodeLimit, 1000);
    assert.equal(record.inherits, true);
    assert.equal(operations.hasPendingRecovery(instance), false);
    const usage = await quota.readUsage(instance, true);
    assert.equal(usage.state, "ready");
    assert.equal(usage.warning, true);
  } finally {
    await operations.dispose();
  }
});

test("a pool at the default instance directory cannot lose a live assignment by clearing it", async () => {
  const oldDefault = config.defaultInstancePath;
  const poolPath = path.join(root, "xfs");
  config.defaultInstancePath = poolPath;
  config.storagePools = [{ id: "pool", name: "Pool", path: poolPath, reserveGiB: 0 }];
  const instance = createInstance("instance1", { storagePoolId: "pool" });
  const operations = new Operations(quota);
  try {
    assert.throws(
      () => operations.update(instance, { docker: { storagePoolId: "" } }, [instance]),
      /outside the current storage pool/
    );
    assert.equal(instance.config.docker.storagePoolId, "pool");
    assert.equal(operations.hasPendingRecovery(instance), false);
    await assert.rejects(quota.validateStoragePools([], [instance]), /cannot be removed/);
  } finally {
    config.defaultInstancePath = oldDefault;
    await operations.dispose();
  }
});

test("a replacement workspace is reinitialized despite matching registry and configuration", async () => {
  const instance = createInstance();
  await quota.ensureDockerHardQuota(instance, instance.config.cwd, 10);
  fs.rmSync(instance.config.cwd, { recursive: true });
  fs.mkdirSync(instance.config.cwd);
  records.get(200000).inherits = false;
  await quota.ensureDockerHardQuota(instance, instance.config.cwd, 10);
  assert.equal(records.get(200000).inherits, true);
  assert.equal(
    commands.filter(({ args }) => args.some((arg) => arg.startsWith("project -s"))).length,
    2
  );
  assert.equal((await quota.readUsage(instance, true)).state, "ready");
});

test("quota setup cannot succeed while the root inheritance check still reports a problem", async () => {
  const instance = createInstance();
  faults.ignoreSetup = true;
  await assert.rejects(quota.ensureDockerHardQuota(instance, instance.config.cwd, 10), /readback/);
  assert.equal(instance.config.docker.storageQuotaProjectId, undefined);
});

test("a failed root repair invalidates its saved identifier until the whole repair succeeds", async () => {
  const instance = createInstance();
  await quota.ensureDockerHardQuota(instance, instance.config.cwd, 10);
  records.get(200000).inherits = false;
  faults.setup = true;
  await assert.rejects(
    quota.ensureDockerHardQuota(instance, instance.config.cwd, 10),
    /Project setup failed/
  );
  assert.equal(instance.config.docker.storageQuotaProjectId, undefined);
  faults.setup = false;
  await quota.ensureDockerHardQuota(instance, instance.config.cwd, 10);
  assert.equal(instance.config.docker.storageQuotaProjectId, 200000);
  assert.equal(records.get(200000).inherits, true);
});

test("a failed hard quota instance on another filesystem cannot block a healthy XFS pool", async () => {
  const good = createInstance("good", { storagePoolId: "pool", maxSpace: 0.001 });
  const bad = createInstance("bad", { maxSpace: 0.001 });
  bad.config.cwd = path.join(root, "non-xfs/bad");
  fs.mkdirSync(bad.config.cwd, { recursive: true });
  config.storagePools = [{ id: "pool", name: "Pool", path: path.join(root, "xfs"), reserveGiB: 0 }];
  quota.setInstanceProvider(() => [good, bad]);
  await quota.ensureDockerHardQuota(good, good.config.cwd, 0.001);
  const operations = new Operations(quota);
  try {
    operations.update(bad, {}, [good, bad]);
    await operations.wait(bad);
    assert.equal(bad.info.storageQuota.state, "error");
    const [pool] = await quota.listStoragePools([good, bad]);
    assert.equal(pool.error, undefined);
    await quota.checkStoragePool(good, [good, bad]);
    await quota.ensureDockerHardQuota(good, good.config.cwd, 0.001);
    assert.equal((await quota.readUsage(good, true)).state, "ready");
    config.storagePools[0].reserveGiB = 1048576;
    await assert.rejects(quota.checkStoragePool(good, [good, bad]), /insufficient/);
  } finally {
    await operations.dispose();
  }
});
