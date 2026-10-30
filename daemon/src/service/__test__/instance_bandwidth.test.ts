import { describe, expect, it } from "vitest";
import {
  getInstanceUploadLimits,
  migrateSharedUploadLimit,
  parseUploadRate
} from "../instance_bandwidth";

describe("independent dedicated and shared upload limits", () => {
  it("adds 10 Mbps dedicated and 10 Mbps shared without changing either setting", () => {
    const config = { sharedBandwidth: true, uploadSpeedLimit: 1250, sharedUploadSpeedLimit: 1250 };
    expect(getInstanceUploadLimits(config)).toEqual({ dedicated: 1250, shared: 1250, total: 2500 });
    expect(config.uploadSpeedLimit).toBe(1250);
    expect(config.sharedUploadSpeedLimit).toBe(1250);
    expect(getInstanceUploadLimits({ ...config, sharedBandwidth: false })).toEqual({
      dedicated: 0,
      shared: 0,
      total: 1250
    });
  });

  it("keeps zero as no per-instance shared ceiling", () => {
    expect(
      getInstanceUploadLimits({
        sharedBandwidth: true,
        uploadSpeedLimit: 1250,
        sharedUploadSpeedLimit: 0
      })
    ).toEqual({ dedicated: 1250, shared: 0, total: 0 });
  });

  it("migrates old shared-only settings exactly once", () => {
    const config: IGlobalInstanceDockerConfig = { sharedBandwidth: true, uploadSpeedLimit: 1250 };
    migrateSharedUploadLimit(config);
    expect(config).toMatchObject({ uploadSpeedLimit: 0, sharedUploadSpeedLimit: 1250 });
    config.uploadSpeedLimit = 1250;
    migrateSharedUploadLimit(config);
    expect(getInstanceUploadLimits(config)).toEqual({ dedicated: 1250, shared: 1250, total: 2500 });
  });

  it("preserves the original nonshared limit when shared bandwidth is enabled", () => {
    const config: IGlobalInstanceDockerConfig = { sharedBandwidth: false, uploadSpeedLimit: 1250 };
    migrateSharedUploadLimit(config);
    config.sharedBandwidth = true;
    config.sharedUploadSpeedLimit = 1250;
    migrateSharedUploadLimit(config);
    expect(config).toMatchObject({ uploadSpeedLimit: 1250, sharedUploadSpeedLimit: 1250 });
  });

  it.each([null, "1250", -1, NaN, Infinity, 125000001, {}, []])(
    "rejects invalid rates before system commands: %j",
    (value) => {
      expect(() => parseUploadRate(value)).toThrow();
    }
  );
});
