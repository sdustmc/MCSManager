const assert = require("node:assert/strict");
const test = require("node:test");

const { parseNumericRunAs } = require("../src/tools/system_user.ts");

test("parses numeric Docker runAs values", () => {
  assert.deepEqual(parseNumericRunAs("1000"), { uid: 1000, gid: undefined });
  assert.deepEqual(parseNumericRunAs("1000:1001"), { uid: 1000, gid: 1001 });
  assert.deepEqual(parseNumericRunAs(" 1000:1001 "), { uid: 1000, gid: 1001 });
});

test("leaves named Docker runAs values for host account resolution", () => {
  assert.equal(parseNumericRunAs("mcsm"), undefined);
  assert.equal(parseNumericRunAs("mcsm:games"), undefined);
});

test("rejects numeric IDs outside the supported range", () => {
  assert.throws(() => parseNumericRunAs("4294967296"), /outside the supported range/);
  assert.throws(() => parseNumericRunAs("1000:4294967296"), /outside the supported range/);
});
