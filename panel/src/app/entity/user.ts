import { IUser } from "./entity_interface";

export enum UserPassWordType {
  md5 = 0,
  bcrypt = 1
}

export interface IUserApp {
  instanceUuid: string;
  daemonId: string;
  expireTime?: number;
  instanceInfo?: any;
}

export const INFINITE_USER_INSTANCE_EXPIRE_TIME = 0;

export function normalizeUserInstanceExpireTime(expireTime: any) {
  const value = Number(expireTime);
  if (!Number.isFinite(value) || value <= 0) return INFINITE_USER_INSTANCE_EXPIRE_TIME;
  return value;
}

export function isUserInstanceExpired(app: Pick<IUserApp, "expireTime">, now = Date.now()) {
  const expireTime = normalizeUserInstanceExpireTime(app.expireTime);
  return expireTime !== INFINITE_USER_INSTANCE_EXPIRE_TIME && expireTime <= now;
}

export function isUserInstanceAvailable(app: Pick<IUserApp, "expireTime">, now = Date.now()) {
  return !isUserInstanceExpired(app, now);
}

export class User implements IUser {
  uuid: string = "";
  userName: string = "";
  passWord: string = "";
  passWordType: number = UserPassWordType.bcrypt;
  salt: string = "";
  permission: number = 0;
  registerTime: string = "";
  loginTime: string = "";
  instances: Array<IUserApp> = [];
  apiKey: string = "";
  isInit: boolean = false;
  secret = "";
  open2FA = false;
  ssoSub = "";
  ssoBound = false;
}

export enum ROLE {
  ADMIN = 10,
  USER = 1,
  GUEST = 0,
  BAN = -1
}
