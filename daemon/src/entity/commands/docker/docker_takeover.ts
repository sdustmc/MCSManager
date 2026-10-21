import { $t } from "../../../i18n";
import Instance from "../../instance/instance";
import logger from "../../../service/log";
import {
  DockerProcessAdapter,
  SetupDockerContainer,
  StartupDockerProcessError
} from "../../../service/docker_process_service";
import InstanceCommand from "../base/command";
import { DefaultDocker } from "../../../service/docker_service";
import Docker from "dockerode";

export default class DockerTakeoverCommand extends InstanceCommand {
  constructor(private containerInfo: Docker.ContainerInfo) {
    super();
  }

  public async exec(instance: Instance) {
    if (instance.status() !== Instance.STATUS_STOP)
      return instance.failure(new Error($t("TXT_CODE_start.instanceNotDown")));
    instance.setLock(true);
    instance.status(Instance.STATUS_STARTING);
    instance.startCount++;
    instance.startTimestamp = Date.now();
    try {
      // Attaching an existing container must not run cold-start quota or directory checks.
      await this.createProcess(instance);
      if (instance.config.endTime && instance.config.endTime <= Date.now())
        await instance.execPreset("kill");
    } catch (error: any) {
      // Keep an unattached live container protected from restart and instance deletion.
      if (!instance.process || instance.status() === Instance.STATUS_STARTING)
        instance.status(Instance.STATUS_BUSY);
      instance.failure(error);
    } finally {
      instance.setLock(false);
    }
  }

  protected async createProcess(instance: Instance) {
    // Docker docks to the process adapter
    const processAdapter = new DockerProcessAdapter(new SetupDockerContainer(instance));
    try {
      const docker = new DefaultDocker();
      const container = docker.getContainer(this.containerInfo.Id);
      if (this.containerInfo.State == "paused") {
        await container.unpause();
      }
      await processAdapter.start(
        {
          isTty: instance.config.terminalOption.pty,
          w: instance.config.terminalOption.ptyWindowCol,
          h: instance.config.terminalOption.ptyWindowRow
        },
        container
      );
    } catch (e) {
      // Retain an explicit kill handle even if the terminal connection could not be attached.
      processAdapter.container ??= new DefaultDocker().getContainer(this.containerInfo.Id);
      processAdapter.pid = this.containerInfo.Id;
      processAdapter.on("exit", () => instance.stopped());
      instance.process = processAdapter;
      logger.error(e);
      logger.error("uuid:", instance.instanceUuid);
      logger.error("container:", this.containerInfo.Id);
      throw new StartupDockerProcessError($t("TXT_CODE_786c22bd"));
    }

    instance.started(processAdapter);
    logger.info(
      $t("TXT_CODE_instance.successful", {
        v: `${instance.config.nickname} ${instance.instanceUuid}`
      })
    );
  }
}
