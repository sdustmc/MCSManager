import { type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { groupKill, spawnApp } from "../../test/integration/lib/process";

let root: string;
let child: ChildProcess | null;
let logFile: string;
const posixIt = process.platform === "win32" ? it.skip : it;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mcsm-process-cleanup-"));
  logFile = path.join(root, "app.log");
  child = null;
});

afterEach(async () => {
  await groupKill(child);
  fs.rmSync(root, { recursive: true, force: true });
});

async function launch(source: string) {
  const app = path.join(root, "app.cjs");
  fs.writeFileSync(app, source);
  child = spawnApp({ app, cwd: root, logFile });
  await once(child.stdout!, "data");
  return child;
}

posixIt("waits for a forced child exit and its final log before removing the workspace", async () => {
  const proc = await launch(`
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
    console.log("READY");
  `);

  await groupKill(proc);

  expect(proc.exitCode !== null || proc.signalCode !== null).toBe(true);
  expect(fs.readFileSync(logFile, "utf8")).toContain("[exit null]");
}, 10000);

posixIt("flushes graceful shutdown output before returning from process cleanup", async () => {
  const proc = await launch(`
    process.on("SIGTERM", () => {
      console.log("SHUTDOWN");
      process.exit(0);
    });
    setInterval(() => {}, 1000);
    console.log("READY");
  `);

  await groupKill(proc);

  const log = fs.readFileSync(logFile, "utf8");
  expect(proc.exitCode).toBe(0);
  expect(log).toContain("SHUTDOWN");
  expect(log).toContain("[exit 0]");
}, 10000);

posixIt("kills surviving group members after the parent has exited", async () => {
  const proc = await launch(`
    require("node:child_process").spawn(process.execPath, ["-e", \`
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
      console.log("READY");
    \`], { stdio: "inherit" });
    setInterval(() => {}, 1000);
  `);

  const cleanup = groupKill(proc);
  let timeout: ReturnType<typeof setTimeout>;
  const completed = await Promise.race([
    cleanup.then(() => true),
    new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), 5000);
    })
  ]);
  clearTimeout(timeout!);
  if (!completed) process.kill(-proc.pid!, "SIGKILL");
  await cleanup;

  expect(completed).toBe(true);
  expect(fs.readFileSync(logFile, "utf8")).toContain("[exit null]");
}, 10000);
