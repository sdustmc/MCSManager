import { execFile, spawn, type ChildProcess } from "child_process";
import fs from "fs/promises";
import { promisify } from "util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NetworkLimitService } from "../network_limit_service";
import { SharedBandwidthService } from "../shared_bandwidth_service";

vi.mock("../log", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// Run only inside a fresh network namespace, never against a real host uplink:
// sudo env MCSM_SHARED_NETWORK_TEST=1 unshare --net --mount --fork sh -c \
//   'ip link set lo up; exec "$@"' -- node node_modules/vitest/vitest.mjs run \
//   src/service/__test__/shared_bandwidth_service.network.test.ts
const networkDescribe = process.env.MCSM_SHARED_NETWORK_TEST === "1" ? describe : describe.skip;
const execute = promisify(execFile);
const run = async (command: string, args: string[]) =>
  (await execute(command, args, { timeout: 15000, maxBuffer: 1024 * 1024 })).stdout;
const ns = (pid: number, command: string, args: string[]) =>
  run("nsenter", ["-t", String(pid), "-n", command, ...args]);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const owner = "isolated-shared-bandwidth-test";
const firstId = "a".repeat(64);
const secondId = "b".repeat(64);
const base = { enabled: true, interface: "wan0", uplinkMbps: 30, sharedMbps: 20 };

networkDescribe("shared outbound bandwidth in an isolated Linux network", () => {
  const children: ChildProcess[] = [];
  const transfers = new Set<Promise<number>>();
  let service = new SharedBandwidthService(owner);
  let receiver: number;
  let first: number;
  let second: number;
  let port = 5200;

  const namespace = async () => {
    const child = spawn(
      "unshare",
      ["--net", process.execPath, "-e", "setInterval(() => {}, 1000)"],
      {
        stdio: "ignore"
      }
    );
    children.push(child);
    const parentNamespace = await fs.readlink("/proc/self/ns/net");
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await fs.readlink(`/proc/${child.pid}/ns/net`)) !== parentNamespace) return child.pid!;
      await wait(10);
    }
    throw new Error("The isolated child network namespace did not start.");
  };

  const endpoint = async (pid: number, host: string, peer: string) => {
    await run("ip", ["link", "add", host, "type", "veth", "peer", "name", peer]);
    await run("ip", ["link", "set", peer, "netns", String(pid)]);
    await run("ip", ["link", "set", host, "up"]);
    await ns(pid, "ip", ["link", "set", "lo", "up"]);
    await ns(pid, "ip", ["link", "set", peer, "up"]);
  };

  beforeAll(async () => {
    expect(process.getuid?.()).toBe(0);
    // This guard is mandatory even when the environment flag is set by mistake.
    const links = JSON.parse(await run("ip", ["-j", "link", "show"]));
    expect(links.map((link: { ifname: string }) => link.ifname)).toEqual(["lo"]);
    expect(await fs.readlink("/proc/self/ns/net")).not.toBe(await fs.readlink("/proc/1/ns/net"));
    receiver = await namespace();
    first = await namespace();
    second = await namespace();
    await run("ip", ["link", "set", "lo", "up"]);
    await run("ip", ["link", "add", "brtest", "type", "bridge"]);
    await run("ip", ["link", "set", "brtest", "up"]);
    await run("ip", ["addr", "add", "198.51.100.1/24", "dev", "brtest"]);
    await run("ip", ["-6", "addr", "add", "2001:db8:2::1/64", "dev", "brtest", "nodad"]);
    await endpoint(receiver, "wan0", "sink0");
    await run("ip", ["addr", "add", "192.0.2.1/24", "dev", "wan0"]);
    await run("ip", ["-6", "addr", "add", "2001:db8:1::1/64", "dev", "wan0", "nodad"]);
    await ns(receiver, "ip", ["addr", "add", "192.0.2.2/24", "dev", "sink0"]);
    await ns(receiver, "ip", ["-6", "addr", "add", "2001:db8:1::2/64", "dev", "sink0", "nodad"]);
    await ns(receiver, "ip", ["-6", "route", "add", "2001:db8:2::/64", "via", "2001:db8:1::1"]);
    for (const [pid, veth, address] of [
      [first, "vethpoola", 2],
      [second, "vethpoolb", 3]
    ] as const) {
      await endpoint(pid, veth, "eth0");
      await run("ip", ["link", "set", veth, "master", "brtest"]);
      await ns(pid, "ip", ["addr", "add", `198.51.100.${address}/24`, "dev", "eth0"]);
      await ns(pid, "ip", ["route", "add", "default", "via", "198.51.100.1"]);
      await ns(pid, "ip", [
        "-6",
        "addr",
        "add",
        `2001:db8:2::${address}/64`,
        "dev",
        "eth0",
        "nodad"
      ]);
      await ns(pid, "ip", ["-6", "route", "add", "default", "via", "2001:db8:2::1"]);
    }
    await run("sysctl", ["-w", "net.ipv4.ip_forward=1"]);
    await run("sysctl", ["-w", "net.ipv6.conf.all.forwarding=1"]);
    // Exercise classification with the same source NAT used by a Docker bridge.
    await run("iptables", ["-t", "nat", "-A", "POSTROUTING", "-o", "wan0", "-j", "MASQUERADE"]);
    await service.configure(base);
  }, 20000);

  afterEach(async () => {
    await Promise.allSettled(transfers);
    await service.leave(firstId);
    await service.leave(secondId);
    await service.configure(base);
    const qdiscs = JSON.parse(await run("tc", ["-j", "qdisc", "show", "dev", "wan0"]));
    expect(qdiscs.some((qdisc: { handle: string }) => qdisc.handle === service.rootHandle)).toBe(
      false
    );
  }, 30000);

  afterAll(async () => {
    for (const child of children) child.kill("SIGKILL");
  });

  const transfer = (pid?: number, ipv6 = false, seconds = 4, udp = true) => {
    const pending = (async () => {
      const testPort = String(++port);
      const server = spawn(
        "nsenter",
        ["-t", String(receiver), "-n", "iperf3", "-s", "-1", "-p", testPort],
        {
          stdio: "ignore"
        }
      );
      children.push(server);
      await wait(150);
      const args = [
        "-J",
        "-c",
        ipv6 ? "2001:db8:1::2" : "192.0.2.2",
        "-p",
        testPort,
        "-t",
        String(seconds),
        ...(udp ? ["-u", "-b", "50M", "-l", "1200"] : [])
      ];
      const output = pid ? await ns(pid, "iperf3", args) : await run("iperf3", args);
      const result = JSON.parse(output);
      if (result.error) throw new Error(result.error);
      return result.end.sum_received.bits_per_second / 1000000;
    })();
    transfers.add(pending);
    void pending.then(
      () => transfers.delete(pending),
      () => transfers.delete(pending)
    );
    return pending;
  };

  const queueCounters = async () => {
    const qdiscs = JSON.parse(await run("tc", ["-s", "-j", "qdisc", "show", "dev", "wan0"])) as {
      kind: string;
      root?: boolean;
      bytes: number;
    }[];
    return {
      normal: qdiscs.find((qdisc) => qdisc.kind === "fq_codel")!.bytes,
      shared: qdiscs.find((qdisc) => qdisc.kind === "tbf" && !qdisc.root)!.bytes,
      time: performance.now()
    };
  };

  it.each([
    [false, 1250, 20],
    [true, 1250, 20],
    [false, 2500, 30]
  ] as const)(
    "adds dedicated and shared allowances: IPv6=%s, shared KB/s=%s, total Mbps=%s",
    async (ipv6, sharedKbps, totalMbps) => {
      await service.join(firstId, "vethpoola", { dedicatedKbps: 1250, sharedKbps });
      const before = await queueCounters();
      const rate = await transfer(first, ipv6);
      const after = await queueCounters();
      const seconds = (after.time - before.time) / 1000;
      const normal = ((after.normal - before.normal) * 8) / seconds / 1000000;
      const shared = ((after.shared - before.shared) * 8) / seconds / 1000000;
      expect(rate).toBeGreaterThan(totalMbps * 0.85);
      expect(rate).toBeLessThan(totalMbps * 1.1);
      expect(normal).toBeGreaterThan(8);
      expect(normal).toBeLessThan(12);
      expect(shared).toBeGreaterThan((sharedKbps / 125) * 0.8);
      expect(shared).toBeLessThan((sharedKbps / 125) * 1.1);
    },
    15000
  );

  it("caps only the shared portions together and removes one member's classifiers", async () => {
    await service.configure({ ...base, uplinkMbps: 50 });
    await service.join(firstId, "vethpoola", { dedicatedKbps: 625, sharedKbps: 2500 });
    await service.join(secondId, "vethpoolb", { dedicatedKbps: 1250, sharedKbps: 2500 });
    const before = await queueCounters();
    const rates = await Promise.all([transfer(first), transfer(second)]);
    const after = await queueCounters();
    expect(rates[0] + rates[1]).toBeGreaterThan(30);
    expect(rates[0] + rates[1]).toBeLessThan(38);
    const shared =
      ((after.shared - before.shared) * 8) / ((after.time - before.time) / 1000) / 1000000;
    expect(shared).toBeGreaterThan(17);
    expect(shared).toBeLessThan(22);
    await service.leave(firstId);
    const qdiscs = JSON.parse(await run("tc", ["-j", "qdisc", "show", "dev", "wan0"]));
    const priorityHandle = qdiscs.find((qdisc: { kind: string }) => qdisc.kind === "prio").handle;
    const classifiers = await run("tc", [
      "filter",
      "show",
      "dev",
      "wan0",
      "parent",
      priorityHandle
    ]);
    expect(
      classifiers
        .split("\n")
        .filter((line) => line.includes(" basic ") && line.includes(" handle "))
    ).toHaveLength(2);
    const remaining = await transfer(second);
    expect(remaining).toBeGreaterThan(26);
    expect(remaining).toBeLessThan(33);
  }, 20000);

  it("keeps the dedicated portion at normal priority when other services saturate the uplink", async () => {
    await service.join(firstId, "vethpoola", { dedicatedKbps: 1250, sharedKbps: 1250 });
    const before = await queueCounters();
    const [mixed, normal] = await Promise.all([
      transfer(first, false, 6),
      transfer(undefined, false, 6)
    ]);
    const after = await queueCounters();
    expect(mixed).toBeGreaterThan(8);
    expect(mixed).toBeLessThan(13);
    expect(normal).toBeGreaterThan(16);
    const shared =
      ((after.shared - before.shared) * 8) / ((after.time - before.time) / 1000) / 1000000;
    expect(shared).toBeLessThan(3);
  }, 20000);

  it("restores both allowances after a daemon restart", async () => {
    const limits = { dedicatedKbps: 1250, sharedKbps: 1250 };
    await service.join(firstId, "vethpoola", limits);
    service = new SharedBandwidthService(owner);
    await service.configure(base);
    await service.join(firstId, "vethpoola", limits);
    const before = await queueCounters();
    const rate = await transfer(first);
    const after = await queueCounters();
    expect(rate).toBeGreaterThan(17);
    expect(rate).toBeLessThan(22);
    expect(after.normal - before.normal).toBeGreaterThan(3500000);
    expect(after.shared - before.shared).toBeGreaterThan(3500000);
  }, 15000);

  it("supports TCP uploads with both allowances", async () => {
    const limiter = NetworkLimitService.getInstance();
    const inventory = vi
      .spyOn(limiter as any, "getContainerNetworkInfo")
      .mockResolvedValue({ pid: first, networkMode: "bridge" });
    const resolveVeth = vi
      .spyOn(limiter as any, "resolveVethFromPid")
      .mockResolvedValue("vethpoola");
    try {
      await run("modprobe", ["ifb", "numifbs=0"]);
      await limiter.setBandwidthLimit(firstId, { uploadLimit: 2500 });
      await service.join(firstId, "vethpoola");
      const baseline = await transfer(first, false, 6, false);
      await service.leave(firstId);
      await service.join(firstId, "vethpoola", { dedicatedKbps: 1250, sharedKbps: 1250 });
      const rate = await transfer(first, false, 6, false);
      expect(rate).toBeGreaterThan(baseline * 0.85);
      expect(rate).toBeGreaterThan(12);
      expect(rate).toBeLessThan(23);
    } finally {
      await Promise.allSettled(transfers);
      try {
        await service.leave(firstId);
        await limiter.clearBandwidthLimit(firstId);
      } finally {
        inventory.mockRestore();
        resolveVeth.mockRestore();
      }
    }
  }, 25000);

  it.each(["-4", "-6"])(
    "refuses conflicting mixed-instance routing marks for %s",
    async (family) => {
      await run("ip", [
        family,
        "rule",
        "add",
        "pref",
        "1235",
        "fwmark",
        "0x10000/0x10000",
        "lookup",
        "100"
      ]);
      try {
        await expect(
          service.join(firstId, "vethpoola", { dedicatedKbps: 1250, sharedKbps: 1250 })
        ).rejects.toThrow();
        const qdiscs = await run("tc", ["-j", "qdisc", "show", "dev", "wan0"]);
        expect(qdiscs).not.toContain(service.rootHandle);
        expect(await run("ip", [family, "-j", "rule", "show"])).toContain("1235");
      } finally {
        await run("ip", [family, "rule", "del", "pref", "1235"]);
      }
    }
  );

  it.each([false, true])(
    "caps two instances together, including IPv6=%s",
    async (ipv6) => {
      await Promise.all([service.join(firstId, "vethpoola"), service.join(secondId, "vethpoolb")]);
      const rates = await Promise.all([transfer(first, ipv6), transfer(second, ipv6)]);
      expect(rates[0] + rates[1]).toBeGreaterThan(17);
      expect(rates[0] + rates[1]).toBeLessThan(22);
    },
    15000
  );

  it("caps instances at 10 and 20 Mbps while keeping their combined limit at 20 Mbps", async () => {
    const limiter = NetworkLimitService.getInstance();
    const endpoints = new Map([
      [firstId, { pid: first, veth: "vethpoola" }],
      [secondId, { pid: second, veth: "vethpoolb" }]
    ]);
    // Only Docker inventory is simulated; shaping and traffic use the real isolated network.
    const inventory = vi
      .spyOn(limiter as any, "getContainerNetworkInfo")
      .mockImplementation(async (id: string) => ({
        pid: endpoints.get(id)!.pid,
        networkMode: "bridge"
      }));
    const resolveVeth = vi
      .spyOn(limiter as any, "resolveVethFromPid")
      .mockImplementation(async (id: string) => endpoints.get(id)!.veth);
    try {
      // Loading IFB must not create default devices in the host namespace.
      await run("modprobe", ["ifb", "numifbs=0"]);
      await service.join(firstId, "vethpoola");
      await service.join(secondId, "vethpoolb");
      await limiter.setBandwidthLimit(firstId, { uploadLimit: 1250 });
      await limiter.setBandwidthLimit(secondId, { uploadLimit: 2500 });

      const firstAlone = await transfer(first);
      expect(firstAlone).toBeGreaterThan(8);
      expect(firstAlone).toBeLessThan(11);
      const secondAlone = await transfer(second);
      // Short IFB bursts and scheduler overhead can reduce achieved throughput.
      expect(secondAlone).toBeGreaterThan(15);
      expect(secondAlone).toBeGreaterThan(firstAlone * 1.5);
      expect(secondAlone).toBeLessThan(22);

      const together = await Promise.all([transfer(first), transfer(second)]);
      expect(together[0]).toBeLessThan(11);
      expect(together[1]).toBeLessThan(22);
      expect(together[0] + together[1]).toBeGreaterThan(17);
      expect(together[0] + together[1]).toBeLessThan(22);
    } finally {
      await Promise.allSettled(transfers);
      try {
        await service.leave(firstId);
        await service.leave(secondId);
        await limiter.clearBandwidthLimit(firstId);
        await limiter.clearBandwidthLimit(secondId);
      } finally {
        inventory.mockRestore();
        resolveVeth.mockRestore();
      }
    }
    const links = JSON.parse(await run("ip", ["-j", "link", "show"]));
    expect(links.some((link: { ifname: string }) => link.ifname.startsWith("ifb_"))).toBe(false);
  }, 40000);

  it.each(["host service", "nonshared instance"])(
    "gives priority to a %s",
    async (source) => {
      const sender = source === "host service" ? undefined : second;
      await service.join(firstId, "vethpoola");
      const baseline = await transfer(sender, false, 3);
      // Establish the low-priority control connection before saturating the normal queue.
      const sharedTransfer = transfer(first, false, 8).then(
        () => undefined,
        (error: { killed?: boolean }) => (error.killed ? undefined : error)
      );
      for (let attempt = 0; attempt < 25; attempt++) {
        if ((await queueCounters()).shared > 500000) break;
        await wait(200);
      }
      expect((await queueCounters()).shared).toBeGreaterThan(500000);
      const normalTransfer = transfer(sender, false, 6);
      await wait(1000);
      const before = await queueCounters();
      await wait(2500);
      const after = await queueCounters();
      const [sharedError] = await Promise.all([sharedTransfer, normalTransfer]);
      if (sharedError) throw sharedError;
      // A starved iperf control connection may time out after the measured data window.
      const seconds = (after.time - before.time) / 1000;
      const normal = ((after.normal - before.normal) * 8) / seconds / 1000000;
      const shared = ((after.shared - before.shared) * 8) / seconds / 1000000;
      expect(normal).toBeGreaterThan(26);
      expect(normal).toBeGreaterThan(baseline * 0.9);
      expect(shared).toBeLessThan(3);
    },
    25000
  );

  it("changes the combined limit while members are running", async () => {
    await service.join(firstId, "vethpoola");
    await service.configure({ ...base, sharedMbps: 10 });
    const rate = await transfer(first);
    expect(rate).toBeGreaterThan(8);
    expect(rate).toBeLessThan(12);
  }, 15000);

  it("restores membership after a daemon restart and releases inherited rules", async () => {
    await service.join(firstId, "vethpoola");
    service = new SharedBandwidthService(owner);
    await service.configure(base);
    await service.join(firstId, "vethpoola");
    const rate = await transfer(first);
    expect(rate).toBeGreaterThan(17);
    expect(rate).toBeLessThan(22);
    await service.leave(firstId);
    const qdiscs = JSON.parse(await run("tc", ["-j", "qdisc", "show", "dev", "vethpoola"]));
    expect(qdiscs.some((qdisc: { kind: string }) => qdisc.kind === "ingress")).toBe(false);
  }, 15000);

  it.each(["classifier", "normal queue", "shared queue"] as const)(
    "repairs an interrupted installation with a missing %s after a daemon restart",
    async (missing) => {
      await service.join(firstId, "vethpoola");
      const qdiscs = JSON.parse(await run("tc", ["-j", "qdisc", "show", "dev", "wan0"])) as {
        kind: string;
        handle: string;
      }[];
      const priorityHandle = qdiscs.find((qdisc) => qdisc.kind === "prio")!.handle;
      // Leave the same partial scheduler as an interrupted installation.
      if (missing === "classifier") {
        await run("tc", ["filter", "del", "dev", "wan0", "parent", priorityHandle]);
      } else {
        await run("tc", [
          "qdisc",
          "del",
          "dev",
          "wan0",
          "parent",
          `${priorityHandle}${missing === "normal queue" ? 1 : 2}`
        ]);
      }
      service = new SharedBandwidthService(owner);
      await service.configure(base);
      await service.join(firstId, "vethpoola");
      const restored = JSON.parse(await run("tc", ["-j", "qdisc", "show", "dev", "wan0"]));
      expect(restored.some((qdisc: { kind: string }) => qdisc.kind === "fq_codel")).toBe(true);
      // Some iproute2 versions emit invalid JSON for fw filters.
      const classifiers = await run("tc", [
        "filter",
        "show",
        "dev",
        "wan0",
        "parent",
        priorityHandle
      ]);
      expect(
        classifiers.split("\n").filter((line) => line.includes(" fw ") && line.includes(" handle "))
      ).toHaveLength(1);
      const rate = await transfer(first);
      expect(rate).toBeGreaterThan(17);
      expect(rate).toBeLessThan(22);
    },
    15000
  );

  it("preserves an existing per-instance IFB upload limit", async () => {
    // No default IFB devices are created in the host namespace when the driver loads.
    await run("modprobe", ["ifb", "numifbs=0"]);
    await run("ip", ["link", "add", "ifbtest", "type", "ifb"]);
    await run("ip", ["link", "set", "ifbtest", "up"]);
    await run("tc", ["qdisc", "add", "dev", "vethpoola", "ingress"]);
    await run("tc", [
      "filter",
      "add",
      "dev",
      "vethpoola",
      "parent",
      "ffff:",
      "protocol",
      "all",
      "u32",
      "match",
      "u32",
      "0",
      "0",
      "action",
      "mirred",
      "egress",
      "redirect",
      "dev",
      "ifbtest"
    ]);
    await run("tc", [
      "qdisc",
      "add",
      "dev",
      "ifbtest",
      "root",
      "tbf",
      "rate",
      "6mbit",
      "burst",
      "64kb",
      "latency",
      "50ms"
    ]);
    try {
      await service.join(firstId, "vethpoola");
      const rate = await transfer(first);
      expect(rate).toBeGreaterThan(4.5);
      expect(rate).toBeLessThan(7);
      await service.leave(firstId);
      expect(await run("tc", ["-j", "filter", "show", "dev", "vethpoola", "ingress"])).toContain(
        "mirred"
      );
    } finally {
      await service.leave(firstId);
      await run("tc", ["qdisc", "del", "dev", "vethpoola", "ingress"]);
      await run("ip", ["link", "del", "ifbtest"]);
    }
  }, 15000);

  it("refuses conflicting policy routing without changing it", async () => {
    await run("ip", [
      "rule",
      "add",
      "pref",
      "1234",
      "fwmark",
      "0x40000000/0x40000000",
      "lookup",
      "100"
    ]);
    try {
      await expect(service.configure({ ...base, uplinkMbps: 29 })).rejects.toThrow();
      expect(await run("ip", ["-j", "rule", "show"])).toContain("1234");
    } finally {
      await run("ip", ["rule", "del", "pref", "1234"]);
    }
  });

  it("removes a stopped container from the pool even after its veth disappears", async () => {
    await service.join(secondId, "vethpoolb");
    await run("ip", ["link", "del", "vethpoolb"]);
    await service.leave(secondId);
  });

  it("keeps active members protected against disabling or switching interfaces", async () => {
    await service.join(firstId, "vethpoola");
    await expect(service.configure({ ...base, enabled: false })).rejects.toThrow();
    await expect(service.configure({ ...base, interface: "lo" })).rejects.toThrow();
    expect(await run("tc", ["-j", "filter", "show", "dev", "vethpoola", "ingress"])).toContain(
      "skbedit"
    );
  });

  it("refuses to overwrite existing traffic control", async () => {
    await run("tc", [
      "qdisc",
      "add",
      "dev",
      "wan0",
      "root",
      "handle",
      "77:",
      "netem",
      "delay",
      "1ms"
    ]);
    try {
      await expect(service.join(firstId, "vethpoola")).rejects.toThrow();
      const qdiscs = JSON.parse(await run("tc", ["-j", "qdisc", "show", "dev", "wan0"]));
      expect(qdiscs.find((qdisc: { root?: boolean }) => qdisc.root)).toMatchObject({
        handle: "77:",
        kind: "netem"
      });
    } finally {
      await run("tc", ["qdisc", "del", "dev", "wan0", "root", "handle", "77:"]);
    }
  });
});
