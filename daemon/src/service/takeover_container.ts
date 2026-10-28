/**
 * MANDATORY TEST GATE — DO NOT MODIFY WITHOUT RE-RUNNING THE INTEGRATION TESTS.
 *
 * This service is exercised by the real instance/Docker integration suite in
 * `src/routers/__test__/Instance_router.integration.test.ts` (real Docker containers).
 * Any change here can break container takeover / cleanup.
 *
 * After editing this file, AI assistants and developers MUST run the
 * `mcsmanager-test` skill and confirm the Docker + instance
 * cases pass before finishing.
 *   Skill: `.agents/skills/mcsmanager-test/SKILL.md`
 */
import { ContainerInfo } from "dockerode";
import DockerTakeoverCommand from "../entity/commands/docker/docker_takeover";
import { DefaultDocker } from "./docker_service";
import InstanceSubsystem from "./system_instance";
import logger from "./log";
import { globalConfiguration } from "../entity/config";
import { SharedBandwidthService } from "./shared_bandwidth_service";

export default async function takeoverContainer() {
  const docker = new DefaultDocker();
  const containers = new Map<string, ContainerInfo>();
  (await docker.listContainers()).forEach((containerInfo) => {
    const label = containerInfo.Labels["mcsmanager.instance.uuid"];
    if (label == null) {
      return;
    }
    if (containers.has(label)) {
      return; // Skip if already exists
    }
    containers.set(label, containerInfo);
  });

  try {
    const service = SharedBandwidthService.getInstance();
    await service.configure(globalConfiguration.config.sharedBandwidth);
    const hasSharedInstance = Array.from(containers.keys()).some(
      (uuid) => InstanceSubsystem.getInstance(uuid)?.config.docker.sharedBandwidth
    );
    if (!hasSharedInstance) await service.cleanupIfIdle();
  } catch (error) {
    logger.error("Failed to restore the shared outbound bandwidth configuration:", error);
  }

  for (const item of containers) {
    const [uuid, container] = item;
    const instance = InstanceSubsystem.getInstance(uuid);
    try {
      if (instance && instance.config.processType == "docker") {
        await instance.forceExec(new DockerTakeoverCommand(container));
      }
    } catch (e) {
      logger.error("Failed to attach an existing Docker container:", uuid, container.Id, e);
    }
  }
}
