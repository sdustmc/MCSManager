import { describe, expect, it, vi } from "vitest";
import { parseSharedBandwidthConfig } from "../shared_bandwidth_service";

vi.mock("../log", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const config = { enabled: true, interface: "eth0", uplinkMbps: 95, sharedMbps: 50 };

describe("shared bandwidth configuration boundaries", () => {
  it("keeps existing nodes disabled and accepts a bounded pool", () => {
    expect(parseSharedBandwidthConfig(undefined)).toEqual({
      enabled: false,
      interface: "",
      uplinkMbps: 0,
      sharedMbps: 0
    });
    expect(parseSharedBandwidthConfig(config)).toEqual(config);
  });

  it.each([
    null,
    { ...config, enabled: "true" },
    { ...config, interface: "eth0;id" },
    { ...config, interface: "-eth0" },
    { ...config, interface: "a".repeat(16) },
    { ...config, sharedMbps: 96 },
    { ...config, sharedMbps: -1 },
    { ...config, sharedMbps: 0 },
    { ...config, sharedMbps: 1.5 },
    { ...config, uplinkMbps: Infinity },
    { ...config, uplinkMbps: NaN },
    { ...config, uplinkMbps: 1000001 },
    { ...config, uplinkMbps: "95" }
  ])("rejects invalid settings before running system commands: %j", (value) => {
    expect(() => parseSharedBandwidthConfig(value)).toThrow();
  });
});
