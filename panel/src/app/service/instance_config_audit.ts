import Koa from "koa";
import { diffConfig } from "../common/config_diff";
import { logger } from "./log";
import { getOperationLoggerOperator, operationLogger } from "./operation_logger";
import RemoteRequest from "./remote_command";
import RemoteServiceSubsystem from "./remote_service";

function recordConfigChange(
  daemonId: string,
  instanceUuid: string,
  configBefore: any,
  configAfter: any,
  operator: ReturnType<typeof getOperationLoggerOperator>
) {
  const diff = diffConfig(configBefore, configAfter);
  if (diff) {
    operationLogger.log(
      "instance_config_change",
      {
        ...operator,
        daemon_id: daemonId,
        instance_id: instanceUuid,
        instance_name: configAfter?.nickname ?? configBefore?.nickname,
        config_before: diff.before,
        config_after: diff.after
      },
      "warning"
    );
  }
}

async function readInstanceConfig(daemonId: string, instanceUuid: string) {
  try {
    const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
    const detail = await new RemoteRequest(remoteService).request("instance/detail", {
      instanceUuid
    });
    return detail?.config ?? null;
  } catch {
    return null;
  }
}

export async function updateInstanceWithAudit<T>(
  ctx: Koa.ParameterizedContext,
  daemonId: string,
  instanceUuid: string,
  update: () => Promise<T>
): Promise<T> {
  const configBefore = await readInstanceConfig(daemonId, instanceUuid);
  const result = await update();
  const operator = getOperationLoggerOperator(ctx);
  if (
    result &&
    typeof result === "object" &&
    "storageQuotaStatus" in result &&
    result.storageQuotaStatus === "applying"
  ) {
    // Keep the HTTP response immediate and audit the verified configuration later.
    void (async () => {
      const remoteService = RemoteServiceSubsystem.getInstance(daemonId);
      const completed = await new RemoteRequest(remoteService).request(
        "instance/storage_quota_wait",
        { instanceUuid },
        30 * 60 * 1000
      );
      if (!completed?.config) throw new Error("Quota completion did not include a configuration");
      recordConfigChange(daemonId, instanceUuid, configBefore, completed.config, operator);
    })().catch((error) => {
      logger.error(
        "Failed to audit asynchronous instance configuration:",
        daemonId,
        instanceUuid,
        error
      );
    });
    return result;
  }
  const configAfter = await readInstanceConfig(daemonId, instanceUuid);
  recordConfigChange(daemonId, instanceUuid, configBefore, configAfter, operator);
  return result;
}
