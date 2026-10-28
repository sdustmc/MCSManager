import { createHash } from "crypto";
import { globalConfiguration } from "../entity/config";
import { $t } from "../i18n";
import logger from "./log";
import { execWithSudo } from "./network_limit_service";

const MARK = "0x40000000";
const MEMBER_PREF = "10";
const MEMBER_HANDLE = "0x4d43";
const DISABLED: ISharedBandwidthConfig = {
  enabled: false,
  interface: "",
  uplinkMbps: 0,
  sharedMbps: 0
};
const validInterface = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,14}$/.test(value);

export function parseSharedBandwidthConfig(value: unknown): ISharedBandwidthConfig {
  if (value === undefined) return { ...DISABLED };
  const config = value as ISharedBandwidthConfig;
  if (
    !config ||
    typeof config.enabled !== "boolean" ||
    (config.interface !== "" && !validInterface(config.interface)) ||
    !Number.isSafeInteger(config.uplinkMbps) ||
    !Number.isSafeInteger(config.sharedMbps) ||
    config.uplinkMbps < 0 ||
    config.uplinkMbps > 1000000 ||
    config.sharedMbps < 0 ||
    config.sharedMbps > config.uplinkMbps ||
    (config.enabled && (!validInterface(config.interface) || config.sharedMbps < 1))
  ) {
    throw new Error($t("TXT_CODE_SHARED_INVALID_CONFIG"));
  }
  return {
    enabled: config.enabled,
    interface: config.interface,
    uplinkMbps: config.uplinkMbps,
    sharedMbps: config.sharedMbps
  };
}

interface Qdisc {
  kind: string;
  handle: string;
  root?: boolean;
}

interface Member {
  veth: string;
  addedIngress: boolean;
}

interface TrafficFilter {
  pref: number;
  kind: string;
  options?: {
    handle?: number;
    actions?: { kind: string; mark?: number; control_action?: { type: string } }[];
  };
}

/** One shared upload pool per node; unclassified traffic always uses the first band. */
export class SharedBandwidthService {
  private static instance?: SharedBandwidthService;
  private config = { ...DISABLED };
  private configured = false;
  private readonly members = new Map<string, Member>();
  private pending: Promise<void> = Promise.resolve();
  public readonly rootHandle: string;
  private readonly priorityHandle: string;
  private readonly sharedHandle: string;
  private readonly normalHandle: string;

  constructor(owner: string) {
    // Keep handles in a daemon-specific range, away from conventional 1:/10: QoS trees.
    const hash = createHash("sha256").update(owner).digest("hex");
    const base = 0x8000 | (parseInt(hash.slice(0, 4), 16) & 0x7ffc);
    this.rootHandle = `${base.toString(16)}:`;
    this.priorityHandle = `${(base + 1).toString(16)}:`;
    this.sharedHandle = `${(base + 2).toString(16)}:`;
    this.normalHandle = `${(base + 3).toString(16)}:`;
  }

  public static getInstance(): SharedBandwidthService {
    return (this.instance ??= new SharedBandwidthService(globalConfiguration.config.key));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation).catch((error: any) => {
      logger.error("Shared bandwidth operation failed:", error);
      throw new Error($t("TXT_CODE_SHARED_FAILED", { error: error.message || String(error) }));
    });
    this.pending = result.then(
      () => {},
      () => {}
    );
    return result;
  }

  public configure(value: unknown): Promise<ISharedBandwidthConfig> {
    return this.enqueue(async () => {
      const next = parseSharedBandwidthConfig(value);
      if (this.configured && JSON.stringify(next) === JSON.stringify(this.config)) return next;
      if (this.members.size > 0 && (!next.enabled || next.interface !== this.config.interface)) {
        throw new Error($t("TXT_CODE_SHARED_STOP_FIRST"));
      }
      if (next.enabled) await this.preflight(next);
      if (this.members.size > 0) {
        try {
          await this.changeRates(next);
        } catch (error) {
          await this.changeRates(this.config).catch((rollbackError) =>
            logger.error("Failed to restore shared bandwidth rates:", rollbackError)
          );
          throw error;
        }
      } else if (this.configured || !next.enabled) {
        if (this.config.interface) await this.cleanupRoot(this.config.interface);
        if (next.interface && next.interface !== this.config.interface) {
          await this.cleanupRoot(next.interface);
        }
      }
      this.config = next;
      this.configured = true;
      return { ...next };
    });
  }

  public join(containerId: string, veth: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.config.enabled) throw new Error($t("TXT_CODE_SHARED_NOT_CONFIGURED"));
      if (!/^[a-f0-9]{12,64}$/.test(containerId) || !validInterface(veth)) {
        throw new Error($t("TXT_CODE_SHARED_INVALID_INSTANCE"));
      }
      if (this.members.get(containerId)?.veth === veth) return;
      const { stdout } = await execWithSudo("ip", ["-j", "-d", "link", "show", "dev", veth]);
      const link = JSON.parse(stdout)[0];
      if (link?.linkinfo?.info_kind !== "veth" || !link.master) {
        throw new Error($t("TXT_CODE_SHARED_BRIDGE_REQUIRED"));
      }
      const first = this.members.size === 0;
      const qdiscs = await this.qdiscs(veth);
      const needsIngress = !qdiscs.some((qdisc) => ["ingress", "clsact"].includes(qdisc.kind));
      const filters = needsIngress ? [] : await this.memberFilters(veth);
      if (
        filters.some(
          (filter) =>
            filter.options && filter.pref === Number(MEMBER_PREF) && !this.isMemberFilter(filter)
        )
      ) {
        throw new Error($t("TXT_CODE_SHARED_QOS_CONFLICT"));
      }
      const inheritedIngress =
        qdiscs.some((qdisc) => qdisc.kind === "ingress") &&
        filters.some((filter) => this.isMemberFilter(filter)) &&
        filters.every((filter) => !filter.options || this.isMemberFilter(filter));
      const member = { veth, addedIngress: needsIngress || inheritedIngress };
      let rootInstalled = false;
      let memberInstalled = false;
      try {
        if (first) {
          await this.preflight(this.config);
          if (await this.checkRoot(this.config.interface)) {
            // Restore every owned child and classifier after an interrupted installation.
            await this.setupPriority();
            await this.changeRates(this.config);
          } else {
            await execWithSudo("tc", [
              "qdisc",
              "replace",
              "dev",
              this.config.interface,
              "root",
              "handle",
              this.rootHandle,
              ...this.rateArgs(this.config.uplinkMbps)
            ]);
            rootInstalled = true;
            await this.setupPriority();
          }
        } else if (!(await this.checkRoot(this.config.interface))) {
          throw new Error($t("TXT_CODE_SHARED_QOS_CONFLICT"));
        }
        if (needsIngress) {
          await execWithSudo("tc", ["qdisc", "add", "dev", veth, "ingress"]);
          memberInstalled = true;
        }
        // Continue to the existing upload/IFB filter; never replace its ingress qdisc.
        if (!filters.some((filter) => this.isMemberFilter(filter))) {
          await execWithSudo("tc", [
            "filter",
            "add",
            "dev",
            veth,
            "ingress",
            "protocol",
            "all",
            "pref",
            MEMBER_PREF,
            "handle",
            MEMBER_HANDLE,
            "matchall",
            "action",
            "skbedit",
            "mark",
            `${MARK}/${MARK}`,
            "continue"
          ]);
          memberInstalled = true;
        }
        this.members.set(containerId, member);
      } catch (error) {
        if (memberInstalled) {
          await this.cleanupMember(member).catch((cleanupError) =>
            logger.error("Failed to clean up a shared bandwidth member:", cleanupError)
          );
        }
        if (rootInstalled) {
          await this.cleanupRoot(this.config.interface).catch((cleanupError) =>
            logger.error("Failed to clean up the shared bandwidth scheduler:", cleanupError)
          );
        }
        throw error;
      }
    });
  }

  public leave(containerId: string): Promise<void> {
    return this.enqueue(async () => {
      const member = this.members.get(containerId);
      if (!member) return;
      await this.cleanupMember(member);
      if (this.members.size === 1) await this.cleanupRoot(this.config.interface);
      this.members.delete(containerId);
    });
  }

  /** Called after Docker inventory confirms no running instance belongs to the pool. */
  public cleanupIfIdle(): Promise<void> {
    return this.enqueue(async () => {
      if (this.members.size === 0 && this.config.interface) {
        await this.cleanupRoot(this.config.interface);
      }
    });
  }

  private async qdiscs(device: string): Promise<Qdisc[]> {
    try {
      const { stdout } = await execWithSudo("tc", ["-j", "qdisc", "show", "dev", device]);
      return JSON.parse(stdout);
    } catch (error: any) {
      if (String(error.stderr).includes("Cannot find device")) return [];
      throw error;
    }
  }

  private async checkRoot(device: string): Promise<boolean> {
    const qdiscs = await this.qdiscs(device);
    const root = qdiscs.find((qdisc) => qdisc.root);
    if (root?.handle === this.rootHandle && root.kind === "tbf") {
      const ownedHandles = [
        this.rootHandle,
        this.priorityHandle,
        this.sharedHandle,
        this.normalHandle
      ];
      if (
        qdiscs.some(
          (qdisc) =>
            qdisc.handle !== "0:" && qdisc.kind !== "clsact" && !ownedHandles.includes(qdisc.handle)
        )
      ) {
        throw new Error($t("TXT_CODE_SHARED_QOS_CONFLICT"));
      }
      return true;
    }
    if (qdiscs.some((qdisc) => qdisc.handle !== "0:" && qdisc.kind !== "clsact")) {
      throw new Error($t("TXT_CODE_SHARED_QOS_CONFLICT"));
    }
    return false;
  }

  private async preflight(config: ISharedBandwidthConfig): Promise<void> {
    if (process.platform !== "linux") throw new Error($t("TXT_CODE_SHARED_DOCKER_REQUIRED"));
    await execWithSudo("ip", ["-j", "link", "show", "dev", config.interface]);
    await this.checkRoot(config.interface);
    for (const family of ["-4", "-6"]) {
      const { stdout } = await execWithSudo("ip", [family, "-j", "rule", "show"]);
      const rules = JSON.parse(stdout) as { fwmark?: string; fwmask?: string }[];
      // Tagging must not change routing decisions for an existing fwmark policy.
      if (
        rules.some(
          (rule) =>
            rule.fwmark !== undefined &&
            ((Number(rule.fwmask ?? "0xffffffff") >>> 0) & Number(MARK)) !== 0
        )
      ) {
        throw new Error($t("TXT_CODE_SHARED_MARK_CONFLICT"));
      }
    }
  }

  private rateArgs(rateMbps: number): string[] {
    return ["tbf", "rate", `${rateMbps}mbit`, "burst", "64kb", "latency", "50ms"];
  }

  private async changeRates(config: ISharedBandwidthConfig): Promise<void> {
    if (!(await this.checkRoot(config.interface))) {
      throw new Error($t("TXT_CODE_SHARED_QOS_CONFLICT"));
    }
    await execWithSudo("tc", [
      "qdisc",
      "change",
      "dev",
      config.interface,
      "root",
      "handle",
      this.rootHandle,
      ...this.rateArgs(config.uplinkMbps)
    ]);
    await execWithSudo("tc", [
      "qdisc",
      "change",
      "dev",
      config.interface,
      "parent",
      `${this.priorityHandle}2`,
      "handle",
      this.sharedHandle,
      ...this.rateArgs(config.sharedMbps)
    ]);
  }

  private async setupPriority(): Promise<void> {
    const device = this.config.interface;
    await execWithSudo("tc", [
      "qdisc",
      "replace",
      "dev",
      device,
      "parent",
      `${this.rootHandle}1`,
      "handle",
      this.priorityHandle,
      "prio",
      "bands",
      "2",
      "priomap",
      ...Array(16).fill("0")
    ]);
    await execWithSudo("tc", [
      "qdisc",
      "replace",
      "dev",
      device,
      "parent",
      `${this.priorityHandle}1`,
      "handle",
      this.normalHandle,
      "fq_codel"
    ]);
    await execWithSudo("tc", [
      "qdisc",
      "replace",
      "dev",
      device,
      "parent",
      `${this.priorityHandle}2`,
      "handle",
      this.sharedHandle,
      ...this.rateArgs(this.config.sharedMbps)
    ]);
    // Consume our private mark at the uplink; preserve every other mark bit.
    await execWithSudo("tc", [
      "filter",
      "replace",
      "dev",
      device,
      "parent",
      this.priorityHandle,
      "protocol",
      "all",
      "pref",
      "1",
      "handle",
      `${MARK}/${MARK}`,
      "fw",
      "classid",
      `${this.priorityHandle}2`,
      "action",
      "skbedit",
      "mark",
      `0/${MARK}`
    ]);
  }

  private async cleanupMember(member: Member): Promise<void> {
    const { stdout } = await execWithSudo("ip", ["-j", "link", "show"]);
    const links = JSON.parse(stdout) as { ifname: string }[];
    if (!links.some((link) => link.ifname === member.veth)) return;
    if (
      !(await this.qdiscs(member.veth)).some((qdisc) => ["ingress", "clsact"].includes(qdisc.kind))
    )
      return;
    const filters = await this.memberFilters(member.veth);
    if (filters.some((filter) => this.isMemberFilter(filter))) {
      await execWithSudo("tc", [
        "filter",
        "del",
        "dev",
        member.veth,
        "ingress",
        "protocol",
        "all",
        "pref",
        MEMBER_PREF,
        "handle",
        MEMBER_HANDLE,
        "matchall"
      ]);
    }
    if (member.addedIngress && filters.every((filter) => filter.pref === Number(MEMBER_PREF))) {
      await execWithSudo("tc", ["qdisc", "del", "dev", member.veth, "ingress"]);
    }
  }

  private async cleanupRoot(device: string): Promise<void> {
    const root = (await this.qdiscs(device)).find((qdisc) => qdisc.root);
    if (root?.handle === this.rootHandle && root.kind === "tbf") {
      await this.checkRoot(device);
      await execWithSudo("tc", ["qdisc", "del", "dev", device, "root", "handle", this.rootHandle]);
    }
  }

  private async memberFilters(veth: string): Promise<TrafficFilter[]> {
    const { stdout } = await execWithSudo("tc", ["-j", "filter", "show", "dev", veth, "ingress"]);
    return JSON.parse(stdout);
  }

  private isMemberFilter(filter: TrafficFilter): boolean {
    return (
      filter.pref === Number(MEMBER_PREF) &&
      filter.kind === "matchall" &&
      filter.options?.handle === Number(MEMBER_HANDLE) &&
      filter.options.actions?.some(
        (action) =>
          action.kind === "skbedit" &&
          action.mark === Number(MARK) &&
          action.control_action?.type === "continue"
      ) === true
    );
  }
}
