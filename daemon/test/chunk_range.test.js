const assert = require("node:assert/strict");
const test = require("node:test");

const { addChunkRange, isChunkRangeFullyCovered } = require("../src/tools/chunk_range.ts");

test("merges adjacent and overlapping upload chunks", () => {
  const ranges = [];
  addChunkRange(ranges, 5, 10);
  addChunkRange(ranges, 0, 5);
  addChunkRange(ranges, 8, 12);

  assert.deepEqual(ranges, [{ start: 0, end: 12 }]);
  assert.equal(isChunkRangeFullyCovered(ranges, 12), true);
});

test("keeps a one-byte upload gap visible", () => {
  const ranges = [];
  addChunkRange(ranges, 0, 4);
  addChunkRange(ranges, 5, 10);

  assert.deepEqual(ranges, [
    { start: 0, end: 4 },
    { start: 5, end: 10 }
  ]);
  assert.equal(isChunkRangeFullyCovered(ranges, 10), false);
});

test("ignores empty chunks", () => {
  const ranges = [];
  addChunkRange(ranges, 0, 0);

  assert.deepEqual(ranges, []);
  assert.equal(isChunkRangeFullyCovered(ranges, 0), false);
});
