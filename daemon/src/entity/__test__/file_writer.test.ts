import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import * as lockfile from "proper-lockfile";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fakeInstance } from "../../../test/harness/mocks";
import FileWriter from "../file_writer";
import type Instance from "../instance/instance";

vi.mock("../../i18n", () => ({ $t: (key: string) => key, i18next: { language: "en_us" } }));
vi.mock("../../service/log", () => ({ default: { info: vi.fn(), error: vi.fn() } }));
vi.mock("../../service/storage_quota_operation_service", () => ({
  default: { assertWritable: vi.fn() }
}));
vi.mock("../../service/upload_manager", () => ({ default: { delete: vi.fn() } }));
vi.mock("../../service/upload_ownership_service", () => ({
  applyDockerRunAsOwnership: vi.fn(async () => {})
}));
vi.mock("../config", () => ({
  globalConfiguration: { config: { maxFileTask: 3 } },
  globalEnv: { fileTaskCount: 0 }
}));

let root: string;
let writers: FileWriter[];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mcsm-file-writer-"));
  writers = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(writers.map((writer) => writer.stop()));
  await fs.remove(root);
});

function createWriter(size: number) {
  const instance = fakeInstance("upload", {
    absoluteCwdPath: () => root,
    info: { fileLock: 0 }
  }) as unknown as Instance;
  const writer = new FileWriter(
    instance,
    "file.txt",
    size,
    false,
    "utf-8",
    path.join(root, "file.txt")
  );
  writers.push(writer);
  return writer;
}

it("retries short writes and releases the lock after the complete file is received", async () => {
  const writer = createWriter(6);
  await writer.init();
  const originalWrite = fs.write;
  vi.spyOn(fs, "write").mockImplementation(async (fd, buffer, offset, length, position) =>
    originalWrite(fd, buffer, offset, Math.min(2, length), position)
  );

  await writer.write(0, Buffer.from("abcdef"));

  expect(await fs.readFile(writer.path, "utf8")).toBe("abcdef");
  expect(writer.isFullyReceived()).toBe(true);
  expect(await lockfile.check(writer.path)).toBe(false);
});

it("waits for an in-flight write before cancelling and deleting an upload", async () => {
  const writer = createWriter(4);
  await writer.init();
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writingStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const originalWrite = fs.write;
  vi.spyOn(fs, "write").mockImplementationOnce(async (fd, buffer, offset, length, position) => {
    started();
    await gate;
    return originalWrite(fd, buffer, offset, length, position);
  });

  const writing = writer.write(0, Buffer.from("data"));
  await writingStarted;
  const stopping = writer.stop();
  release();
  await Promise.all([writing, stopping]);

  expect(await fs.pathExists(writer.path)).toBe(false);
  expect(await fs.pathExists(writer.path + ".lock")).toBe(false);
});

it("cleans up a failed write without leaving a resumable upload or lock", async () => {
  const writer = createWriter(4);
  await writer.init();
  vi.spyOn(fs, "write").mockRejectedValueOnce(new Error("disk error"));

  await expect(writer.write(0, Buffer.from("data"))).rejects.toThrow("disk error");

  expect(writer.hasFailed()).toBe(true);
  expect(await fs.pathExists(writer.path)).toBe(false);
  expect(await fs.pathExists(writer.path + ".lock")).toBe(false);
});

it("preserves another upload's locked file when initialization fails", async () => {
  const writer = createWriter(2);
  await fs.writeFile(writer.path, "original");
  const release = await lockfile.lock(writer.path);
  try {
    await expect(writer.init()).rejects.toThrow();
    await writer.stop();
    expect(await fs.readFile(writer.path, "utf8")).toBe("original");
  } finally {
    await release();
  }
});

it("completes an empty file without waiting for an upload piece", async () => {
  const writer = createWriter(0);
  await writer.init();

  await writer.completeIfCovered();

  expect((await fs.stat(writer.path)).size).toBe(0);
  expect(await lockfile.check(writer.path)).toBe(false);
});
