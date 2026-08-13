import { promisify } from "util";
import { exec } from "child_process";
import type Instance from "../entity/instance/instance";

// Promisify the exec function to use async/await
const execAsync = promisify(exec);

export interface RunAsUserIds {
  uid: number;
  gid?: number;
}

const MAX_SYSTEM_ID = 0xfffffffe;

export function parseNumericRunAs(runAs: string): RunAsUserIds | undefined {
  const match = runAs.trim().match(/^(\d+)(?::(\d+))?$/);
  if (!match) return undefined;

  const uid = Number(match[1]);
  const gid = match[2] === undefined ? undefined : Number(match[2]);
  if (
    !Number.isSafeInteger(uid) ||
    uid < 0 ||
    uid > MAX_SYSTEM_ID ||
    (gid !== undefined && (!Number.isSafeInteger(gid) || gid < 0 || gid > MAX_SYSTEM_ID))
  ) {
    throw new Error('"Run As User" Error: UID or GID is outside the supported range');
  }

  return { uid, gid };
}

/**
 * Retrieves the Linux system UID and GID for a given username
 */
export async function getLinuxSystemId(username: string): Promise<{ uid: number; gid: number }> {
  // Validate input: ensure username is a non-empty string
  if (!username || typeof username !== "string" || username.trim() === "") {
    throw new Error('"Run As User" Error: Username must be a non-empty string');
  }

  // Sanitize username to prevent command injection (allow only alphanumeric, underscore, and hyphen)
  const sanitizedUsername = username.replace(/[^a-zA-Z0-9_-]/g, "");
  if (sanitizedUsername !== username) {
    throw new Error('"Run As User" Error: Username contains unsafe characters');
  }

  try {
    // Execute `id -u` and `id -g` commands in parallel with a 5-second timeout
    const [uidResult, gidResult] = await Promise.all([
      execAsync(`id -u ${sanitizedUsername}`, { timeout: 5000 }),
      execAsync(`id -g ${sanitizedUsername}`, { timeout: 5000 })
    ]);

    // Check for errors in stderr
    if (uidResult.stderr || gidResult.stderr) {
      throw new Error(`Command error: ${uidResult.stderr || gidResult.stderr}`);
    }

    // Parse UID and GID from command output
    const uid = parseInt(uidResult.stdout.trim());
    const gid = parseInt(gidResult.stdout.trim());

    // Validate parsed UID and GID
    if (isNaN(uid) || isNaN(gid)) {
      throw new Error("Failed to parse UID or GID: Invalid output from id command");
    }

    return { uid, gid };
  } catch (error: any) {
    throw new Error(`Unable to retrieve UID/GID for user "${sanitizedUsername}": ${error.message}`);
  }
}

export async function getLinuxSystemGroupId(groupName: string): Promise<number> {
  if (!groupName || typeof groupName !== "string" || groupName.trim() === "") {
    throw new Error('"Run As User" Error: Group must be a non-empty string');
  }
  const sanitizedGroupName = groupName.replace(/[^a-zA-Z0-9_-]/g, "");
  if (sanitizedGroupName !== groupName) {
    throw new Error('"Run As User" Error: Group contains unsafe characters');
  }
  try {
    const result = await execAsync(`getent group ${sanitizedGroupName}`, { timeout: 5000 });
    if (result.stderr) throw new Error(`Command error: ${result.stderr}`);
    const gid = Number(result.stdout.trim().split(":")[2]);
    if (!Number.isSafeInteger(gid) || gid < 0 || gid > MAX_SYSTEM_ID) {
      throw new Error("Failed to parse GID: Invalid output from getent command");
    }
    return gid;
  } catch (error: any) {
    throw new Error(`Unable to retrieve GID for group "${sanitizedGroupName}": ${error.message}`);
  }
}

export async function resolveDockerRunAsUserIds(runAs: string): Promise<RunAsUserIds> {
  const normalizedRunAs = runAs.trim();
  if (!normalizedRunAs) {
    throw new Error('"Run As User" Error: User must be a non-empty string');
  }

  const numericIds = parseNumericRunAs(normalizedRunAs);
  if (numericIds) return numericIds;

  const parts = normalizedRunAs.split(":");
  if (parts.length === 2) {
    const [userName, groupName] = parts;
    const numericUser = parseNumericRunAs(userName);
    const userIds = numericUser ?? (await getLinuxSystemId(userName));
    const numericGroup = parseNumericRunAs(groupName);
    const gid = numericGroup ? numericGroup.uid : await getLinuxSystemGroupId(groupName);
    return {
      uid: userIds.uid,
      gid
    };
  }
  if (parts.length > 2) {
    throw new Error('"Run As User" Error: Invalid user and group format');
  }

  return await getLinuxSystemId(normalizedRunAs);
}

export async function getRunAsUserParams(instance: Instance) {
  // Get user info for the target user (Linux/macOS only)
  let uid: number | undefined = undefined;
  let gid: number | undefined = undefined;
  let isEnableRunAs = false;
  const name = instance.config.runAs;
  if (name && String(name).trim() && process.platform !== "win32") {
    const result = await getLinuxSystemId(name);
    uid = result.uid;
    gid = result.gid;
    // Do not consider forcibly changing the ownership of instance files,
    // as this may cause unexpected situations for users.
    // try {
    //   await execAsync(`chown -R ${uid}:${gid} "${instance.absoluteCwdPath()}"`);
    // } catch (error) {
    //   instance.println("WARN", $t("TXT_CODE_fcdc758"));
    //   instance.println("WARN", String(error));
    // }
    isEnableRunAs = true;
  }
  return { uid, gid, isEnableRunAs, runAsName: name };
}
