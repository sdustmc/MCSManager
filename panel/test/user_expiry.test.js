const assert = require("node:assert/strict");
const test = require("node:test");

const { isUserInstanceAvailable, isUserInstanceExpired } = require("../src/app/entity/user.ts");

test("assignments without a user expiry are unlimited", () => {
  assert.equal(isUserInstanceExpired({}, 1_000), false);
  assert.equal(isUserInstanceAvailable({}, 1_000), true);
});

test("zero is unlimited while finite timestamps expire normally", () => {
  assert.equal(isUserInstanceExpired({ expireTime: 0 }, 1_000), false);
  assert.equal(isUserInstanceExpired({ expireTime: 999 }, 1_000), true);
  assert.equal(isUserInstanceExpired({ expireTime: 1_001 }, 1_000), false);
});
