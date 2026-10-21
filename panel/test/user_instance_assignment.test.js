const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { after, afterEach, beforeEach, mock, test } = require("node:test");

const projectRoot = path.resolve(__dirname, "../..");
const originalDirectory = process.cwd();
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mcsm-user-assignment-"));
const originalResolve = Module._resolveFilename;
const originalSetInterval = global.setInterval;
const importIntervals = [];

global.setInterval = (...args) => {
  const timer = originalSetInterval(...args);
  importIntervals.push(timer);
  return timer;
};

// Match production Webpack aliases without loading application data.
Module._resolveFilename = function (request, ...args) {
  if (request.startsWith("@languages/")) {
    request = path.join(projectRoot, "languages", request.slice("@languages/".length));
  }
  if (request === "mcsmanager-common") {
    request = path.join(projectRoot, "common/src/index.ts");
  }
  return originalResolve.call(this, request, ...args);
};
process.chdir(temporaryDirectory);
const tsNode = require("ts-node");
process[tsNode.REGISTER_INSTANCE]?.enabled(false);
tsNode.register({
  project: path.join(projectRoot, "panel/tsconfig.json"),
  files: true
});

let UserSubsystem, Storage, RemoteRequest, remotes, logger, ROLE, User;
try {
  ({ UserSubsystem } = require("../src/app/service/user_service.ts"));
  ({ default: Storage } = require("../src/app/common/storage/sys_storage.ts"));
  ({ default: RemoteRequest } = require("../src/app/service/remote_command.ts"));
  ({ default: remotes } = require("../src/app/service/remote_service.ts"));
  ({ logger } = require("../src/app/service/log.ts"));
  ({ ROLE, User } = require("../src/app/entity/user.ts"));
} finally {
  Module._resolveFilename = originalResolve;
  global.setInterval = originalSetInterval;
  process.chdir(originalDirectory);
}

let users, persisted, remoteInstances, calls, failures, loggedErrors;
const key = (daemonId, instanceUuid) => `${daemonId}/${instanceUuid}`;
const assignment = (expireTime = 0, instanceUuid = "server-1", daemonId = "node-1") => ({
  daemonId,
  instanceUuid,
  expireTime
});

function addUser(uuid, permission = ROLE.USER, instances = []) {
  const user = Object.assign(new User(), { uuid, userName: uuid, permission, instances });
  users.setInstance(uuid, user);
  persisted.set(uuid, JSON.parse(JSON.stringify(user)));
  return user;
}

beforeEach(() => {
  users = new UserSubsystem();
  persisted = new Map();
  remoteInstances = new Map([[key("node-1", "server-1"), { endTime: 1000, nickname: "Server 1" }]]);
  calls = [];
  failures = {};
  loggedErrors = [];
  mock.method(Storage, "getStorage", () => ({
    async store(category, uuid, user) {
      assert.equal(category, "User");
      if (failures.store) throw failures.store;
      persisted.set(uuid, JSON.parse(JSON.stringify(user)));
    },
    async delete(category, uuid) {
      persisted.delete(uuid);
    }
  }));
  mock.method(remotes, "getInstance", (uuid) => ({ uuid, socket: {} }));
  mock.method(RemoteRequest.prototype, "request", async function (event, payload) {
    calls.push({ daemonId: this.rService.uuid, event, payload });
    if (event === "instance/section") {
      if (failures.read) throw failures.read;
      return payload.instanceUuids.flatMap((instanceUuid) => {
        const config = remoteInstances.get(key(this.rService.uuid, instanceUuid));
        return config ? [{ instanceUuid, config: { ...config } }] : [];
      });
    }
    assert.equal(event, "instance/update");
    const config = remoteInstances.get(key(this.rService.uuid, payload.instanceUuid));
    assert.ok(config);
    Object.assign(config, payload.config);
    // Fail after applying the update to model an ambiguous remote timeout.
    if (failures.update) await failures.update(payload);
    return { instanceUuid: payload.instanceUuid };
  });
  mock.method(logger, "error", (...args) => loggedErrors.push(args));
});

afterEach(() => mock.restoreAll());
after(async () => {
  importIntervals.forEach(clearInterval);
  await new Promise((resolve) => require("log4js").shutdown(resolve));
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test("assigning and renewing a user also persists the instance expiry", async () => {
  const user = addUser("alice");
  for (const expireTime of [2000, 3000]) {
    await users.edit(user.uuid, { instances: [assignment(expireTime)] });
    assert.equal(user.instances[0].expireTime, expireTime);
    assert.equal(persisted.get(user.uuid).instances[0].expireTime, expireTime);
    assert.deepEqual(remoteInstances.get("node-1/server-1"), {
      endTime: expireTime,
      nickname: "Server 1"
    });
  }
});

test("clearing the user's expiry also clears the instance expiry", async () => {
  const user = addUser("alice", ROLE.USER, [assignment(1000)]);
  await users.edit(user.uuid, { instances: [assignment()] });
  assert.equal(user.instances[0].expireTime, 0);
  assert.equal(remoteInstances.get("node-1/server-1").endTime, 0);
});

test("saving an existing assignment repairs a different instance expiry", async () => {
  const user = addUser("alice", ROLE.USER, [assignment(2000)]);
  await users.edit(user.uuid, { instances: [assignment(2000)] });
  assert.equal(user.instances[0].expireTime, 2000);
  assert.equal(remoteInstances.get("node-1/server-1").endTime, 2000);
});

test("rejects another ordinary user's assignment even when the first assignment has expired", async () => {
  addUser("alice", ROLE.USER, [assignment(1)]);
  const user = addUser("bob");
  await assert.rejects(
    users.edit(user.uuid, { instances: [assignment(2000)] }),
    /already assigned to user alice/
  );
  assert.deepEqual(user.instances, []);
  assert.deepEqual(persisted.get(user.uuid).instances, []);
  assert.equal(calls.length, 0);
});

test("instance ownership includes the daemon ID", async () => {
  addUser("alice", ROLE.USER, [assignment(2000)]);
  const user = addUser("bob");
  remoteInstances.set("node-2/server-1", { endTime: 1000 });
  await users.edit(user.uuid, { instances: [assignment(3000, "server-1", "node-2")] });
  assert.equal(remoteInstances.get("node-1/server-1").endTime, 1000);
  assert.equal(remoteInstances.get("node-2/server-1").endTime, 3000);
});

test("administrator assignments neither reserve an instance nor overwrite the ordinary user's expiry", async () => {
  const admin = addUser("admin", ROLE.ADMIN, [assignment(5000)]);
  const user = addUser("alice");
  await users.edit(user.uuid, { instances: [assignment(2000)] });
  await users.edit(admin.uuid, { instances: [assignment(6000)] });
  assert.equal(remoteInstances.get("node-1/server-1").endTime, 2000);
  assert.equal(admin.instances[0].expireTime, 6000);
});

test("downgrading an administrator cannot introduce a second ordinary owner", async () => {
  addUser("alice", ROLE.USER, [assignment(2000)]);
  const admin = addUser("admin", ROLE.ADMIN, [assignment(3000)]);
  await assert.rejects(users.edit(admin.uuid, { permission: ROLE.USER }), /already assigned/);
  assert.equal(admin.permission, ROLE.ADMIN);
  assert.equal(persisted.get(admin.uuid).permission, ROLE.ADMIN);
  assert.equal(calls.length, 0);
});

test("downgrading an unshared administrator synchronizes its assigned expiry", async () => {
  const admin = addUser("admin", ROLE.ADMIN, [assignment(3000)]);
  await users.edit(admin.uuid, { permission: ROLE.USER });
  assert.equal(admin.permission, ROLE.USER);
  assert.equal(remoteInstances.get("node-1/server-1").endTime, 3000);
});

test("invalid and duplicate assignments are rejected before any user or remote changes", async () => {
  const user = addUser("alice");
  for (const instances of [
    null,
    {},
    [null],
    [assignment(), assignment(2000)],
    [assignment(0, "../server")]
  ]) {
    await assert.rejects(
      users.edit(user.uuid, { userName: "changed", instances }),
      /Invalid or duplicate/
    );
    assert.equal(user.userName, "alice");
    assert.deepEqual(user.instances, []);
  }
  assert.equal(calls.length, 0);
});

test("an unavailable daemon prevents saving the new assignment", async () => {
  const user = addUser("alice");
  failures.read = new Error("Daemon offline");
  await assert.rejects(users.edit(user.uuid, { instances: [assignment(2000)] }), /Daemon offline/);
  assert.deepEqual(user.instances, []);
  assert.deepEqual(persisted.get(user.uuid).instances, []);
  assert.equal(remoteInstances.get("node-1/server-1").endTime, 1000);
  assert.equal(loggedErrors.length, 1);
});

test("checks all assigned instances before changing any remote expiry", async () => {
  const user = addUser("alice");
  await assert.rejects(
    users.edit(user.uuid, {
      instances: [assignment(2000), assignment(3000, "missing-server")]
    })
  );
  assert.equal(remoteInstances.get("node-1/server-1").endTime, 1000);
  assert.ok(calls.every((call) => call.event === "instance/section"));
  assert.deepEqual(user.instances, []);
});

test("a partial remote failure restores every attempted expiry and keeps user data unchanged", async () => {
  const user = addUser("alice");
  remoteInstances.set("node-1/server-2", { endTime: 1500 });
  let failed = false;
  failures.update = async (payload) => {
    if (!failed && payload.instanceUuid === "server-2") {
      failed = true;
      throw new Error("Remote timeout");
    }
  };
  await assert.rejects(
    users.edit(user.uuid, {
      instances: [assignment(2000), assignment(3000, "server-2")]
    }),
    /Remote timeout/
  );
  assert.equal(remoteInstances.get("node-1/server-1").endTime, 1000);
  assert.equal(remoteInstances.get("node-1/server-2").endTime, 1500);
  assert.deepEqual(user.instances, []);
  assert.deepEqual(persisted.get(user.uuid).instances, []);
});

test("a user storage failure restores the instance expiry", async () => {
  const user = addUser("alice", ROLE.USER, [assignment(1000)]);
  failures.store = new Error("Storage unavailable");
  await assert.rejects(
    users.edit(user.uuid, { instances: [assignment(2000)] }),
    /Storage unavailable/
  );
  assert.equal(user.instances[0].expireTime, 1000);
  assert.equal(persisted.get(user.uuid).instances[0].expireTime, 1000);
  assert.equal(remoteInstances.get("node-1/server-1").endTime, 1000);
});

test("concurrent assignments can only succeed for one ordinary user", async () => {
  addUser("alice");
  addUser("bob");
  const results = await Promise.allSettled([
    users.edit("alice", { instances: [assignment(2000)] }),
    users.edit("bob", { instances: [assignment(3000)] })
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(
    Array.from(users.objects.values()).filter((user) => user.instances.length > 0).length,
    1
  );
  assert.equal(remoteInstances.get("node-1/server-1").endTime, 2000);
  const { mutexIdMap } = require("../src/app/utils/sync.ts");
  assert.equal(mutexIdMap.size, 0);
});

test("an instance can be transferred after its previous assignment is removed", async () => {
  addUser("alice", ROLE.USER, [assignment(1000)]);
  addUser("bob");
  await users.edit("alice", { instances: [] });
  await users.edit("bob", { instances: [assignment(2000)] });
  assert.deepEqual(users.getInstance("alice").instances, []);
  assert.equal(users.getInstance("bob").instances[0].expireTime, 2000);
  assert.equal(remoteInstances.get("node-1/server-1").endTime, 2000);
});

test("failed creation does not leave a phantom user or assignment behind", async () => {
  addUser("alice", ROLE.USER, [assignment(1000)]);
  await assert.rejects(
    users.create({
      userName: "bob",
      permission: ROLE.USER,
      instances: [assignment(2000)]
    }),
    /already assigned/
  );
  assert.equal(users.objects.size, 1);
  assert.equal(persisted.size, 1);
});

test("unrelated account edits and banning a user do not require the daemon", async () => {
  const user = addUser("alice", ROLE.USER, [assignment(1000)]);
  failures.read = new Error("Daemon offline");
  await users.edit(user.uuid, { isInit: true });
  await users.edit(user.uuid, { permission: ROLE.BAN });
  assert.equal(user.isInit, true);
  assert.equal(user.permission, ROLE.BAN);
  assert.equal(calls.length, 0);
});

for (const action of ["unbind", "unbindAll", "bind"]) {
  test(`SSO ${action} is serialized with instance expiry synchronization`, async () => {
    const user = addUser("alice", ROLE.USER, [assignment(1000)]);
    Object.assign(user, { ssoSub: "old-sub", ssoBound: true });
    let enteredUpdate, releaseUpdate;
    const updateEntered = new Promise((resolve) => (enteredUpdate = resolve));
    const updateReleased = new Promise((resolve) => (releaseUpdate = resolve));
    failures.update = async () => {
      enteredUpdate();
      await updateReleased;
    };
    const editing = users.edit(user.uuid, { instances: [assignment(2000)] });
    await updateEntered;
    let bindingSaved = false;
    const binding = (
      action === "bind"
        ? users.bindSso(user.uuid, "new-sub")
        : action === "unbindAll"
        ? users.unbindAllSso()
        : users.unbindSso(user.uuid)
    ).then((value) => {
      bindingSaved = true;
      return value;
    });
    try {
      await new Promise(setImmediate);
      assert.equal(bindingSaved, false);
    } finally {
      releaseUpdate();
    }
    await editing;
    const result = await binding;
    if (action === "unbindAll") assert.equal(result, 1);
    assert.equal(user.instances[0].expireTime, 2000);
    assert.equal(user.ssoSub, action === "bind" ? "new-sub" : "");
    assert.equal(user.ssoBound, action === "bind");
    assert.equal(persisted.get(user.uuid).ssoSub, user.ssoSub);
    assert.equal(persisted.get(user.uuid).ssoBound, user.ssoBound);
    const { mutexIdMap } = require("../src/app/utils/sync.ts");
    assert.equal(mutexIdMap.size, 0);
  });
}

test("failed SSO persistence leaves the in-memory binding unchanged", async () => {
  const user = addUser("alice");
  Object.assign(user, { ssoSub: "old-sub", ssoBound: true });
  failures.store = new Error("Storage unavailable");
  await assert.rejects(users.unbindSso(user.uuid), /Storage unavailable/);
  assert.equal(user.ssoSub, "old-sub");
  assert.equal(user.ssoBound, true);
  await assert.rejects(users.bindSso(user.uuid, "new-sub"), /Storage unavailable/);
  assert.equal(user.ssoSub, "old-sub");
});
