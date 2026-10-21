import bcrypt from "bcryptjs";
import { t } from "i18next";
import { LocalFileSource, QueryWrapper } from "mcsmanager-common";
import md5 from "md5";
import { authenticator } from "otplib";
import { v4 } from "uuid";
import Storage from "../common/storage/sys_storage";
import { IUser } from "../entity/entity_interface";
import {
  IUserApp,
  normalizeUserInstanceExpireTime,
  ROLE,
  User,
  UserPassWordType
} from "../entity/user";
import { $t } from "../i18n";
import { execWithMutexId } from "../utils/sync";
import { logger } from "./log";
import RemoteRequest from "./remote_command";
import RemoteServiceSubsystem from "./remote_service";

export class TwoFactorError extends Error {}

const USER_INSTANCE_ASSIGNMENT_LOCK = "user-instance-assignments";

export class UserSubsystem {
  public readonly objects: Map<string, User> = new Map();

  async initialize() {
    for (const uuid of await Storage.getStorage().list("User")) {
      const user = (await Storage.getStorage().load("User", User, uuid)) as User;
      this.objects.set(uuid, user);
    }
    logger.info($t("TXT_CODE_systemUser.userCount", { n: this.objects.size }));
  }

  async create(config: IUser): Promise<User> {
    const newUuid = v4().replace(/-/gim, "");
    // Initialize necessary user data
    const instance = new User();
    instance.uuid = newUuid;
    instance.registerTime = new Date().toLocaleString();
    // add to the user system
    this.setInstance(newUuid, instance);
    try {
      await this.edit(instance.uuid, config);
    } catch (error) {
      this.objects.delete(newUuid);
      throw error;
    }
    return instance;
  }

  // Update user detail
  async edit(uuid: string, config: any) {
    return execWithMutexId(USER_INSTANCE_ASSIGNMENT_LOCK, async () => {
      const instance = this.getInstance(uuid);
      if (!instance) return;
      const nextUser = Object.assign(new User(), instance);
      if (config.userName) nextUser.userName = config.userName;
      if (config.isInit != null) nextUser.isInit = Boolean(config.isInit);
      if (config.permission != null) nextUser.permission = Number(config.permission);
      if (config.registerTime) nextUser.registerTime = config.registerTime;
      if (config.loginTime) nextUser.loginTime = config.loginTime;
      if (config.apiKey != null) nextUser.apiKey = config.apiKey;
      if (config.secret != null) nextUser.secret = String(config.secret);
      if (config.open2FA != null) nextUser.open2FA = Boolean(config.open2FA);
      if (config.ssoSub != null) nextUser.ssoSub = String(config.ssoSub);
      if (config.ssoBound != null) nextUser.ssoBound = Boolean(config.ssoBound);

      const assignmentsChanged =
        config.instances !== undefined || nextUser.permission !== instance.permission;
      if (assignmentsChanged) {
        nextUser.instances = this.prepareUserInstances(
          nextUser,
          config.instances !== undefined ? config.instances : instance.instances
        );
      }
      if (config.passWord) {
        nextUser.passWordType = UserPassWordType.bcrypt;
        nextUser.passWord = bcrypt.hashSync(config.passWord, 10);
      }

      const save = async () => {
        await Storage.getStorage().store("User", uuid, nextUser);
        Object.assign(instance, nextUser);
      };
      const shouldSyncExpiry = config.instances !== undefined || instance.permission === ROLE.ADMIN;
      if (assignmentsChanged && shouldSyncExpiry && nextUser.permission !== ROLE.ADMIN) {
        await this.syncInstanceExpiry(nextUser.instances, save);
      } else {
        await save();
      }
    });
  }

  validatePassword(password = "") {
    if (password.length < 9 || password.length > 36) return false;
    const reg = /(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])/;
    return reg.test(password);
  }

  check2FA(code: string, user: IUser, totpDriftToleranceSteps: number = 0) {
    if (!user.secret)
      throw new Error("Please contact the administrator to reset the account password");
    authenticator.options = { window: totpDriftToleranceSteps };
    const delta = authenticator.checkDelta(code, user?.secret);
    return delta != null;
  }

  checkUser(info: IUser, code2FA?: string, totpDriftToleranceSteps: number = 0) {
    const inputPassword = info.passWord || "";
    for (const [uuid, user] of this.objects) {
      if (user.userName === info.userName) {
        if (
          user.open2FA &&
          user.secret &&
          !this.check2FA(code2FA || "", user, totpDriftToleranceSteps)
        )
          throw new TwoFactorError(t("TXT_CODE_3d68e43b"));
        if (user.passWordType === UserPassWordType.bcrypt) {
          if (!bcrypt.compareSync(inputPassword, user.passWord))
            throw new Error($t("TXT_CODE_fefbb457"));
        } else {
          if (!(md5(inputPassword) === user.passWord)) throw new Error($t("TXT_CODE_fefbb457"));
        }
      }
    }
  }

  existUserName(userName: string): boolean {
    let flag = false;
    this.objects.forEach((user) => {
      if (user.userName === userName) return (flag = true);
    });
    return flag;
  }

  private prepareUserInstances(user: User, instanceIds: IUserApp[]): IUserApp[] {
    if (!Array.isArray(instanceIds))
      throw new Error($t("TXT_CODE_USER_INSTANCE_INVALID_ASSIGNMENT"));
    const instanceKeys = new Set<string>();
    const instances = instanceIds.map((value) => {
      if (
        !value ||
        typeof value.daemonId !== "string" ||
        typeof value.instanceUuid !== "string" ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(value.daemonId) ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(value.instanceUuid)
      ) {
        throw new Error($t("TXT_CODE_USER_INSTANCE_INVALID_ASSIGNMENT"));
      }
      const key = `${value.daemonId}/${value.instanceUuid}`;
      if (instanceKeys.has(key)) throw new Error($t("TXT_CODE_USER_INSTANCE_INVALID_ASSIGNMENT"));
      instanceKeys.add(key);
      return {
        instanceUuid: value.instanceUuid,
        daemonId: value.daemonId,
        expireTime: normalizeUserInstanceExpireTime(value.expireTime)
      };
    });

    if (user.permission !== ROLE.ADMIN) {
      for (const otherUser of this.objects.values()) {
        if (otherUser.uuid === user.uuid || otherUser.permission === ROLE.ADMIN) continue;
        const conflict = otherUser.instances.find((instance) =>
          instanceKeys.has(`${instance.daemonId}/${instance.instanceUuid}`)
        );
        if (conflict) {
          throw new Error(
            $t("TXT_CODE_USER_INSTANCE_ALREADY_ASSIGNED", {
              uuid: conflict.instanceUuid,
              user: otherUser.userName
            })
          );
        }
      }
    }
    return instances;
  }

  private async syncInstanceExpiry(instances: IUserApp[], save: () => Promise<void>) {
    const changes: Array<{
      request: RemoteRequest;
      instance: IUserApp;
      previousEndTime: number;
    }> = [];
    const attempted: typeof changes = [];
    try {
      for (const instance of instances) {
        const request = new RemoteRequest(RemoteServiceSubsystem.getInstance(instance.daemonId));
        const details = await request.request("instance/section", {
          instanceUuids: [instance.instanceUuid]
        });
        const detail = details?.find(
          (item: { instanceUuid: string }) => item.instanceUuid === instance.instanceUuid
        );
        if (!detail?.config) throw new Error($t("TXT_CODE_3bfb9e04"));
        const previousEndTime = normalizeUserInstanceExpireTime(detail.config.endTime);
        if (previousEndTime !== instance.expireTime) {
          changes.push({ request, instance, previousEndTime });
        }
      }
      for (const change of changes) {
        // A timed-out request may still have changed the remote configuration.
        attempted.push(change);
        await change.request.request("instance/update", {
          instanceUuid: change.instance.instanceUuid,
          config: { endTime: change.instance.expireTime }
        });
      }
      await save();
    } catch (error) {
      logger.error("Failed to save user instance assignments:", instances, error);
      for (const change of attempted.reverse()) {
        try {
          await change.request.request("instance/update", {
            instanceUuid: change.instance.instanceUuid,
            config: { endTime: change.previousEndTime }
          });
        } catch (rollbackError) {
          logger.error("Failed to restore instance expiry:", change.instance, rollbackError);
        }
      }
      throw error;
    }
  }

  async deleteUserInstances(uuid: string | null, instanceIds: IUserApp[], allUsers = false) {
    return execWithMutexId(USER_INSTANCE_ASSIGNMENT_LOCK, async () => {
      if (uuid && allUsers) {
        throw new Error("Type error, The uuid and allUsers cannot be true at the same time.");
      }
      const users = allUsers ? Array.from(this.objects.values()) : [this.getInstance(uuid!)];
      if (!users || users.length === 0) return;
      instanceIds.forEach((value) => {
        if (!value.daemonId || !value.instanceUuid)
          throw new Error("Type error, The instances of user must be IUserHaveInstance array.");
      });
      for (const user of users) {
        if (!user) continue;
        const nextInstances = user.instances.filter((value) => {
          for (const instance of instanceIds) {
            if (
              instance.daemonId === value.daemonId &&
              instance.instanceUuid === value.instanceUuid
            )
              return false;
          }
          return true;
        });
        if (nextInstances.length === user.instances.length) continue;
        await Storage.getStorage().store("User", user.uuid, { ...user, instances: nextInstances });
        user.instances = nextInstances;
      }
    });
  }

  getUserByUserName(userName: string) {
    for (const map of this.objects) {
      const user = map[1];
      if (user.userName === userName) return user;
    }
    return null;
  }

  getUserByUuid(uuid: string) {
    return this.objects.get(uuid) || null;
  }

  getInstance(uuid: string) {
    return this.objects.get(uuid);
  }

  setInstance(uuid: string, object: User) {
    this.objects.set(uuid, object);
  }

  hasInstance(uuid: string) {
    return this.objects.has(uuid);
  }

  async deleteInstance(uuid: string) {
    return execWithMutexId(USER_INSTANCE_ASSIGNMENT_LOCK, async () => {
      if (this.hasInstance(uuid)) {
        await Storage.getStorage().delete("User", uuid);
        this.objects.delete(uuid);
      }
    });
  }

  getUserBySsoSub(ssoSub: string): User | null {
    for (const [, user] of this.objects) {
      if (user.ssoSub && user.ssoSub === ssoSub) return user;
    }
    return null;
  }

  async unbindSso(uuid: string) {
    return execWithMutexId(USER_INSTANCE_ASSIGNMENT_LOCK, async () => {
      const instance = this.getInstance(uuid);
      if (instance) await this.saveSsoBinding(instance, "");
    });
  }

  async unbindAllSso(): Promise<number> {
    return execWithMutexId(USER_INSTANCE_ASSIGNMENT_LOCK, async () => {
      let count = 0;
      for (const user of this.objects.values()) {
        if (user.ssoBound || user.ssoSub) {
          await this.saveSsoBinding(user, "");
          count++;
        }
      }
      return count;
    });
  }

  async bindSso(uuid: string, ssoSub: string) {
    return execWithMutexId(USER_INSTANCE_ASSIGNMENT_LOCK, async () => {
      const instance = this.getInstance(uuid);
      if (!instance) throw new Error("User not found");
      await this.saveSsoBinding(instance, ssoSub);
    });
  }

  private async saveSsoBinding(user: User, ssoSub: string) {
    const binding = { ssoSub, ssoBound: Boolean(ssoSub) };
    await Storage.getStorage().store("User", user.uuid, { ...user, ...binding });
    Object.assign(user, binding);
  }

  getQueryWrapper() {
    return new QueryWrapper(new LocalFileSource<User>(this.objects));
  }
}

export default new UserSubsystem();
