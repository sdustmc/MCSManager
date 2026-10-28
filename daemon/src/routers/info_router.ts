import Instance from "../entity/instance/instance";
import * as protocol from "../service/protocol";
import { routerApp } from "../service/router_app";
import InstanceSubsystem from "../service/system_instance";

import fs from "fs-extra";
import i18next from "i18next";
import { systemInfo, toBoolean, toNumber, toText } from "mcsmanager-common";
import { LOCAL_PRESET_LANG_PATH } from "../const";
import { globalConfiguration } from "../entity/config";
import { $t } from "../i18n";
import { DockerManager } from "../service/docker_service";
import logger from "../service/log";
import VisualDataSubsystem from "../service/system_visual_data";
import { getVersion } from "../service/version";
import storageQuotaService from "../service/storage_quota_service";
import { SharedBandwidthService } from "../service/shared_bandwidth_service";

// Get the basic information of the daemon system
routerApp.on("info/overview", async (ctx) => {
  const daemonVersion = getVersion();
  let total = 0;
  let running = 0;
  InstanceSubsystem.getInstances().forEach((v) => {
    total++;
    if (v.status() == Instance.STATUS_RUNNING) running++;
  });

  let dockerPlatforms: string[] | undefined;
  try {
    const dockerManager = new DockerManager();
    dockerPlatforms = await dockerManager.getSupportedPlatforms();
  } catch (error: any) {
    logger.debug("Failed to get Docker platforms:", error);
  }

  const info = {
    version: daemonVersion,
    process: {
      cpu: process.cpuUsage().system,
      memory: process.memoryUsage().heapUsed,
      cwd: process.cwd()
    },
    instance: {
      running,
      total
    },
    system: systemInfo(),
    cpuMemChart: VisualDataSubsystem.getSystemChartArray(),
    config: {
      language: globalConfiguration.config.language,
      uploadSpeedRate: globalConfiguration.config.uploadSpeedRate,
      downloadSpeedRate: globalConfiguration.config.downloadSpeedRate,
      maxDownloadFromUrlFileCount: globalConfiguration.config.maxDownloadFromUrlFileCount,
      portRangeStart: globalConfiguration.config.allocatablePortRange[0],
      portRangeEnd: globalConfiguration.config.allocatablePortRange[1],
      portAssignInterval: globalConfiguration.config.portAssignInterval,
      port: globalConfiguration.config.port,
      outputBufferSize: globalConfiguration.config.outputBufferSize,
      enableSoftShutdown: globalConfiguration.config.enableSoftShutdown,
      softShutdownSkipDocker: globalConfiguration.config.softShutdownSkipDocker,
      softShutdownWaitSeconds: globalConfiguration.config.softShutdownWaitSeconds,
      storagePools: globalConfiguration.config.storagePools || [],
      sharedBandwidth: globalConfiguration.config.sharedBandwidth
    },
    dockerPlatforms
  };
  protocol.response(ctx, info);
});

routerApp.on("info/setting", async (ctx, data) => {
  let storagePools: IStoragePoolConfig[] | undefined;
  if (data.storagePools !== undefined) {
    try {
      storagePools = await storageQuotaService.validateStoragePools(
        data.storagePools,
        InstanceSubsystem.getInstances()
      );
    } catch (error: any) {
      logger.error("Storage pool validation failed:", error);
      protocol.error(ctx, "info/setting", { err: error.message });
      return;
    }
  }
  const previousSharedBandwidth = globalConfiguration.config.sharedBandwidth;
  let sharedBandwidth: ISharedBandwidthConfig | undefined;
  if (data.sharedBandwidth !== undefined) {
    try {
      sharedBandwidth = await SharedBandwidthService.getInstance().configure(data.sharedBandwidth);
    } catch (error: any) {
      logger.error("Shared bandwidth configuration failed:", error);
      protocol.error(ctx, "info/setting", {
        err: error.message
      });
      return;
    }
  }
  const language = toText(data.language);
  const uploadSpeedRate = toNumber(data.uploadSpeedRate);
  const downloadSpeedRate = toNumber(data.downloadSpeedRate);
  const maxDownloadFromUrlFileCount = toNumber(data.maxDownloadFromUrlFileCount);
  const portRangeStart = toNumber(data.portRangeStart);
  const portRangeEnd = toNumber(data.portRangeEnd);
  const portAssignInterval = toNumber(data.portAssignInterval);
  const port = toNumber(data.port);
  const outputBufferSize = toNumber(data.outputBufferSize);
  const enableSoftShutdown = toBoolean(data.enableSoftShutdown);
  const softShutdownSkipDocker = toBoolean(data.softShutdownSkipDocker);
  const softShutdownWaitSeconds = toNumber(data.softShutdownWaitSeconds);
  if (language) {
    logger.warn($t("TXT_CODE_66e32091"), language);
    i18next.changeLanguage(language);
    fs.remove(LOCAL_PRESET_LANG_PATH, () => {});
    globalConfiguration.config.language = language;
  }
  if (uploadSpeedRate != null && uploadSpeedRate >= 0) {
    globalConfiguration.config.uploadSpeedRate = uploadSpeedRate;
  }
  if (downloadSpeedRate != null && downloadSpeedRate >= 0) {
    globalConfiguration.config.downloadSpeedRate = downloadSpeedRate;
  }
  if (maxDownloadFromUrlFileCount != null && maxDownloadFromUrlFileCount >= 0) {
    globalConfiguration.config.maxDownloadFromUrlFileCount = maxDownloadFromUrlFileCount;
  }
  if (portRangeStart != null && portRangeEnd != null && portRangeStart < portRangeEnd) {
    globalConfiguration.config.allocatablePortRange = [portRangeStart, portRangeEnd];
    globalConfiguration.config.currentAllocatablePort = portRangeStart;
  }
  if (portAssignInterval != null && portAssignInterval > 0) {
    globalConfiguration.config.portAssignInterval = portAssignInterval;
  }
  if (port && port > 0 && port < 65535) {
    globalConfiguration.config.port = port;
  }
  if (outputBufferSize != null && outputBufferSize >= 16 && outputBufferSize <= 4096) {
    globalConfiguration.config.outputBufferSize = outputBufferSize;
  }
  if (enableSoftShutdown != null) {
    globalConfiguration.config.enableSoftShutdown = enableSoftShutdown;
  }
  if (softShutdownSkipDocker != null) {
    globalConfiguration.config.softShutdownSkipDocker = softShutdownSkipDocker;
  }
  if (
    softShutdownWaitSeconds != null &&
    softShutdownWaitSeconds >= 1 &&
    softShutdownWaitSeconds <= 600
  ) {
    globalConfiguration.config.softShutdownWaitSeconds = softShutdownWaitSeconds;
  }
  if (storagePools) globalConfiguration.config.storagePools = storagePools;
  if (sharedBandwidth) globalConfiguration.config.sharedBandwidth = sharedBandwidth;
  try {
    globalConfiguration.store();
  } catch (error) {
    globalConfiguration.config.sharedBandwidth = previousSharedBandwidth;
    if (data.sharedBandwidth !== undefined) {
      await SharedBandwidthService.getInstance().configure(previousSharedBandwidth);
    }
    throw error;
  }
  protocol.response(ctx, true);
});

routerApp.on("info/storage_pools", async (ctx) => {
  try {
    protocol.response(
      ctx,
      await storageQuotaService.listStoragePools(InstanceSubsystem.getInstances())
    );
  } catch (error: any) {
    logger.error("Failed to list storage pools:", error);
    protocol.error(ctx, "info/storage_pools", { err: error.message });
  }
});
