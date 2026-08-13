import { defaultInstanceInfo } from "@/types/const";
import type { UserInstance } from "@/types/user";
import { describe, expect, it, vi } from "vitest";
import {
  createPortableTemplateFromInstance,
  findTemplateSensitiveFields
} from "./instanceTemplate";

vi.mock("@/lang/i18n", () => ({
  t: (key: string) => key
}));

describe("createPortableTemplateFromInstance", () => {
  it("keeps portable settings and removes secrets and host-specific privileges", () => {
    const config = JSON.parse(JSON.stringify(defaultInstanceInfo)) as IGlobalInstanceConfig;
    Object.assign(config, {
      nickname: "private-name",
      processType: "docker",
      startCommand: "java -jar server.jar",
      remarks: "internal customer note",
      runAs: "root",
      enableRcon: true,
      rconPassword: "rcon-secret",
      java: { id: "daemon-specific-java" },
      extraServiceConfig: {
        openFrpTunnelId: "123",
        openFrpToken: "frp-secret"
      }
    });
    Object.assign(config.docker, {
      image: "example/server:latest",
      containerName: "private-container",
      env: ["PASSWORD=secret"],
      ports: ["25565:25565/tcp"],
      extraVolumes: ["/etc:/host-etc"],
      labels: ["token=secret"],
      devices: ["/dev/sda:/dev/sda"],
      privileged: true,
      networkMode: "host",
      storageQuotaProjectId: 200000,
      enableHardStorageQuota: true,
      gpuEnabled: true,
      gpuDeviceIds: ["GPU-private"]
    });
    const instance: UserInstance = {
      hostIp: "127.0.0.1",
      instanceUuid: "instance-id",
      nickname: "private-name",
      daemonId: "daemon-id",
      status: 0,
      config
    };

    const template = createPortableTemplateFromInstance(instance, "en_us");

    expect(template.language).toBe("en_us");
    expect(template.title).toBe("");
    expect(template.description).toBe("");
    expect(template.setupInfo.nickname).toBe("");
    expect(template.setupInfo.startCommand).toBe("java -jar server.jar");
    expect(template.setupInfo.remarks).toBe("");
    expect(template.setupInfo.runAs).toBe("");
    expect(template.setupInfo.rconPassword).toBe("");
    expect(template.setupInfo.extraServiceConfig).toEqual({
      openFrpTunnelId: "",
      openFrpToken: ""
    });
    expect(template.setupInfo.java.id).toBe("");
    expect(template.setupInfo.docker.image).toBe("example/server:latest");
    expect(template.setupInfo.docker).toMatchObject({
      containerName: "",
      env: [],
      ports: [],
      extraVolumes: [],
      labels: [],
      devices: [],
      privileged: false,
      networkMode: "bridge",
      enableHardStorageQuota: false,
      gpuEnabled: false,
      gpuDeviceIds: []
    });
    expect(template.setupInfo.docker.storageQuotaProjectId).toBeUndefined();
  });

  it("rejects non-Docker instances", () => {
    const config = JSON.parse(JSON.stringify(defaultInstanceInfo)) as IGlobalInstanceConfig;
    config.processType = "general";
    const instance = {
      hostIp: "127.0.0.1",
      instanceUuid: "instance-id",
      nickname: "general",
      daemonId: "daemon-id",
      status: 0,
      config
    };

    expect(() => createPortableTemplateFromInstance(instance, "en_us")).toThrow(
      "Only Docker instances"
    );
  });
});

describe("findTemplateSensitiveFields", () => {
  it("reports field paths without exposing secret values", () => {
    const findings = findTemplateSensitiveFields({
      packages: [
        {
          targetLink: "https://user:private@example.com/server.zip",
          setupInfo: {
            startCommand: "server --token=private-token",
            rconPassword: "private-rcon",
            docker: { env: ["NORMAL=value", "API_KEY=private-key"] }
          }
        }
      ]
    });

    expect(findings).toEqual([
      "packages.0.setupInfo.docker.env.1",
      "packages.0.setupInfo.rconPassword",
      "packages.0.setupInfo.startCommand",
      "packages.0.targetLink"
    ]);
    expect(findings.join(" ")).not.toContain("private-token");
  });

  it("allows ordinary template commands and links", () => {
    expect(
      findTemplateSensitiveFields({
        targetLink: "https://example.com/server.zip",
        setupInfo: { startCommand: "java -jar server.jar", docker: { env: [] } }
      })
    ).toEqual([]);
  });
});
