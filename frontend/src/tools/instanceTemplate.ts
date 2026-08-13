import type { QuickStartPackages } from "@/types";
import { defaultQuickStartPackages } from "@/types/const";
import type { UserInstance } from "@/types/user";

const SENSITIVE_KEY_PATTERN =
  /(?:password|passwd|pwd|token|secret|api[_-]?key|authorization|credential|private[_-]?key)/i;
const SENSITIVE_VALUE_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /(?:password|passwd|pwd|token|secret|api[_-]?key|authorization)\s*(?:=|:)\s*[^\s,;&]+/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /(?:https?|ftp):\/\/[^\s/:@]+:[^\s/@]+@/i
];

function hasMeaningfulValue(value: unknown) {
  if (value == null || value === false || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

export function findTemplateSensitiveFields(value: unknown) {
  const findings = new Set<string>();
  const visit = (current: unknown, currentPath: string) => {
    if (typeof current === "string") {
      if (SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(current))) {
        findings.add(currentPath);
      }
      return;
    }
    if (!current || typeof current !== "object") return;

    for (const [key, child] of Object.entries(current)) {
      const childPath = currentPath ? `${currentPath}.${key}` : key;
      if (SENSITIVE_KEY_PATTERN.test(key) && hasMeaningfulValue(child)) {
        findings.add(childPath);
      }
      visit(child, childPath);
    }
  };
  visit(value, "");
  return Array.from(findings).sort();
}

export function createPortableTemplateFromInstance(
  instance: UserInstance,
  language: string
): QuickStartPackages {
  if (!instance.config || instance.config.processType !== "docker") {
    throw new Error("Only Docker instances can be converted into portable templates.");
  }

  const template = JSON.parse(JSON.stringify(defaultQuickStartPackages)) as QuickStartPackages;
  const source = instance.config;
  const sourceDocker = source.docker || {};
  const setupInfo = template.setupInfo;
  template.title = "";
  template.description = "";
  template.language = language;

  // Build from an allowlist. Runtime credentials, internal remarks, host bindings,
  // devices and daemon-specific identifiers must never be published.
  Object.assign(setupInfo, {
    nickname: "",
    startCommand: source.startCommand || "",
    stopCommand: source.stopCommand || "^c",
    stopTimeout: source.stopTimeout || 0,
    cwd: "",
    ie: source.ie || "UTF-8",
    oe: source.oe || "UTF-8",
    createDatetime: Date.now(),
    lastDatetime: 0,
    type: source.type,
    tag: [],
    remarks: "",
    endTime: 0,
    fileCode: source.fileCode || "UTF-8",
    processType: "docker",
    updateCommand: source.updateCommand || "",
    runAs: "",
    actionCommandList: [],
    crlf: source.crlf,
    category: source.category,
    basePort: undefined as any,
    enableRcon: false,
    rconPassword: "",
    rconPort: undefined,
    rconIp: "",
    java: { id: "" },
    terminalOption: JSON.parse(JSON.stringify(source.terminalOption || setupInfo.terminalOption)),
    eventTask: JSON.parse(JSON.stringify(source.eventTask || setupInfo.eventTask)),
    pingConfig: { ip: "", port: undefined, type: 1 },
    extraServiceConfig: { openFrpTunnelId: "", openFrpToken: "" }
  });

  Object.assign(setupInfo.docker, {
    updateCommandImage: sourceDocker.updateCommandImage || "",
    containerName: "",
    image: sourceDocker.image || "",
    memory: sourceDocker.memory,
    ports: [],
    extraVolumes: [],
    maxSpace: sourceDocker.maxSpace,
    enableHardStorageQuota: false,
    storageQuotaProjectId: undefined,
    network: sourceDocker.network,
    io: sourceDocker.io,
    networkMode: "bridge",
    networkAliases: [],
    cpusetCpus: "",
    cpuUsage: sourceDocker.cpuUsage,
    workingDir: sourceDocker.workingDir || "/data",
    env: [],
    changeWorkdir: sourceDocker.changeWorkdir,
    memorySwap: sourceDocker.memorySwap,
    memorySwappiness: sourceDocker.memorySwappiness,
    labels: [],
    capAdd: [],
    capDrop: [],
    devices: [],
    privileged: false,
    uploadSpeedLimit: sourceDocker.uploadSpeedLimit,
    downloadSpeedLimit: sourceDocker.downloadSpeedLimit,
    gpuEnabled: false,
    gpuCount: -1,
    gpuDeviceIds: [],
    gpuDriver: "nvidia",
    deviceReadBps: [],
    deviceWriteBps: []
  });
  return template;
}
