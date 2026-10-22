import fs from "fs-extra";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isPathOutsideWorkspace, resolvePhysicalPath } from "../path_link_check";

vi.mock("path", async () => {
  const actual = await vi.importActual<typeof import("path")>("path");
  return { ...actual, default: actual.win32 };
});
vi.mock("os", () => ({ default: { platform: () => "win32" } }));
vi.mock("fs-extra", () => ({
  default: { lstatSync: vi.fn(), readlinkSync: vi.fn() }
}));

const links = new Map<string, string>();

beforeEach(() => {
  links.clear();
  vi.mocked(fs.lstatSync).mockImplementation(
    (target) => ({ isSymbolicLink: () => links.has(String(target)) }) as fs.Stats
  );
  vi.mocked(fs.readlinkSync).mockImplementation((target) => links.get(String(target))!);
});

describe("Windows physical workspace boundaries", () => {
  it("retains the drive of an absolute junction target", () => {
    links.set("C:\\workspace\\link", "D:\\workspace");

    expect(resolvePhysicalPath("C:\\workspace\\link\\secret.txt")).toBe(
      "D:\\workspace\\secret.txt"
    );
    expect(isPathOutsideWorkspace("C:\\workspace", "C:\\workspace\\link\\secret.txt")).toBe(
      true
    );
  });

  it("retains the server and share of an extended UNC junction target", () => {
    links.set("C:\\workspace\\link", "\\\\?\\UNC\\server\\share\\workspace");

    expect(resolvePhysicalPath("C:\\workspace\\link\\secret.txt")).toBe(
      "\\\\server\\share\\workspace\\secret.txt"
    );
    expect(isPathOutsideWorkspace("C:\\workspace", "C:\\workspace\\link\\secret.txt")).toBe(
      true
    );
  });

  it("allows children of a workspace that is itself a cross-drive junction", () => {
    links.set("C:\\workspace", "\\\\?\\D:\\instances\\workspace");

    expect(resolvePhysicalPath("C:\\workspace\\file.txt")).toBe(
      "D:\\instances\\workspace\\file.txt"
    );
    expect(isPathOutsideWorkspace("C:\\workspace", "C:\\workspace\\file.txt")).toBe(false);
  });

  it("resolves subsequent links and parent segments on the target drive", () => {
    links.set("C:\\workspace\\link", "D:\\outside");
    links.set("D:\\outside\\back", "C:\\workspace\\sub");

    expect(resolvePhysicalPath("C:\\workspace\\link\\back\\..\\file.txt")).toBe(
      "C:\\workspace\\file.txt"
    );
    expect(
      isPathOutsideWorkspace("C:\\workspace", "C:\\workspace\\link\\back\\..\\file.txt")
    ).toBe(false);
  });
});
