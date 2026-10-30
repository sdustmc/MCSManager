import { $t } from "../i18n";

export function parseUploadRate(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 125000000) {
    throw new Error($t("TXT_CODE_SHARED_INVALID_INSTANCE"));
  }
  return value;
}

export function getInstanceUploadLimits(config: IGlobalInstanceDockerConfig) {
  const upload = parseUploadRate(config.uploadSpeedLimit);
  const shared = config.sharedBandwidth ? parseUploadRate(config.sharedUploadSpeedLimit) : 0;
  const dedicated = config.sharedBandwidth ? upload : 0;
  // A zero shared ceiling keeps the existing unlimited-per-instance setting.
  const total = config.sharedBandwidth ? (shared > 0 ? shared + dedicated : 0) : upload;
  return { shared, dedicated, total: parseUploadRate(total) };
}

export function migrateSharedUploadLimit(config: IGlobalInstanceDockerConfig): void {
  if (config.sharedUploadSpeedLimit !== undefined) return;
  config.sharedUploadSpeedLimit = config.sharedBandwidth ? config.uploadSpeedLimit ?? 0 : 0;
  if (config.sharedBandwidth) config.uploadSpeedLimit = 0;
}
