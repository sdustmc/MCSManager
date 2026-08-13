const assert = require("node:assert/strict");
const test = require("node:test");

const { parseBooleanQuery } = require("../src/tools/http_query.ts");

test("parses explicit true query values", () => {
  assert.equal(parseBooleanQuery("true"), true);
  assert.equal(parseBooleanQuery("1"), true);
  assert.equal(parseBooleanQuery(true), true);
  assert.equal(parseBooleanQuery(["true", "false"]), true);
});

test("does not treat explicit false query values as true", () => {
  assert.equal(parseBooleanQuery("false"), false);
  assert.equal(parseBooleanQuery("0"), false);
  assert.equal(parseBooleanQuery(""), false);
  assert.equal(parseBooleanQuery(false), false);
});

test("uses the supplied default for missing or invalid values", () => {
  assert.equal(parseBooleanQuery(undefined), false);
  assert.equal(parseBooleanQuery(undefined, true), true);
  assert.equal(parseBooleanQuery("invalid", true), true);
  assert.equal(parseBooleanQuery("invalid"), false);
});
