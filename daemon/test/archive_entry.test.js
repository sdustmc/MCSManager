const assert = require("node:assert/strict");
const test = require("node:test");

const { isArchiveLink } = require("../src/tools/archive_entry.ts");

test("detects Unix symbolic links from ZIP external attributes", () => {
  assert.equal(
    isArchiveLink({
      name: "link",
      isDirectory: false,
      attr: 0xa1ff0000
    }),
    true
  );
});

test("detects links reported by 7-Zip without rejecting regular files", () => {
  assert.equal(isArchiveLink({ name: "link", isDirectory: false, isLink: true }), true);
  assert.equal(isArchiveLink({ name: "server.jar", isDirectory: false, attr: 0x81b40000 }), false);
  assert.equal(isArchiveLink({ name: "plugins", isDirectory: true }), false);
});
