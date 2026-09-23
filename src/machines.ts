import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SavedMachine {
  id: string;
  label: string;
  user: string | null;
  host: string;
  port: number;
  /** Disabled machines keep their profile but hold no connection. Files
   * written before this field existed omit it, which means enabled. */
  enabled?: boolean;
  /** Shepherd session on the remote host; null or missing means default. */
  remoteSession?: string | null;
}

export interface SavedMachineFile {
  version: 1;
  machines: SavedMachine[];
}

export function machinesDirectory(): string {
  const override = process.env.SHEPHERD_CONFIG_HOME;
  return override
    ? path.resolve(override)
    : path.join(os.homedir(), ".config", "shepherd");
}

export function machinesPath(): string {
  return path.join(machinesDirectory(), "machines.json");
}

export function loadMachines(): SavedMachineFile {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(machinesPath(), "utf8"),
    ) as SavedMachineFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.machines)) {
      throw new Error("invalid machines.json");
    }
    return {
      version: 1,
      machines: parsed.machines.filter(isSavedMachine),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, machines: [] };
    }
    throw error;
  }
}

export function saveMachines(file: SavedMachineFile): void {
  const directory = machinesDirectory();
  fs.mkdirSync(directory, { recursive: true });
  const target = machinesPath();
  const temporary = `${target}.tmp`;
  fs.writeFileSync(
    temporary,
    `${JSON.stringify(file, null, 2)}\n`,
    "utf8",
  );
  fs.renameSync(temporary, target);
}

export function parseMachineTarget(value: string): {
  user: string | null;
  host: string;
} {
  const { user, host } = parseSshDestination(value);
  return { user, host };
}

/** Parses `host`, `user@host`, or `ssh://[user@]host[:port]`. The host may
 * be an alias from the user's SSH config. Values ssh could read as an
 * option (a leading `-`) or that contain shell metacharacters are rejected. */
export function parseSshDestination(value: string): {
  user: string | null;
  host: string;
  port: number | null;
} {
  let rest = value.trim();
  let port: number | null = null;
  if (/^ssh:\/\//i.test(rest)) {
    rest = rest.slice("ssh://".length).replace(/\/+$/, "");
    const withPort = /^(.*):(\d+)$/.exec(rest);
    if (withPort && !/^\[[^\]]*$/.test(withPort[1] ?? "")) {
      port = Number.parseInt(withPort[2] ?? "", 10);
      rest = withPort[1] ?? "";
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`invalid SSH port: ${withPort[2]}`);
      }
    }
  }
  const atIndex = rest.lastIndexOf("@");
  const user = atIndex === -1 ? null : rest.slice(0, atIndex);
  let host = atIndex === -1 ? rest : rest.slice(atIndex + 1);
  if (user !== null && !/^[a-z_][a-z0-9._-]*$/i.test(user)) {
    throw new Error(`invalid SSH user: ${user}`);
  }
  const bracketed = /^\[([0-9a-fA-F:.]+)\]$/.exec(host);
  if (bracketed) {
    host = bracketed[1] ?? "";
  } else if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(host)) {
    throw new Error(`invalid SSH host: ${host}`);
  }
  if (host.includes("..")) throw new Error(`invalid SSH host: ${host}`);
  return { user, host, port };
}

/** Labels are shown in the sidebar and accepted wherever a machine is
 * named. They keep their case; lookups ignore it. */
export function validateMachineLabel(label: string): string {
  const trimmed = label.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 64 ||
    trimmed.startsWith("-") ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(trimmed)
  ) {
    throw new Error(
      "machine labels must be 1-64 printable characters and must not start with -",
    );
  }
  return trimmed;
}

export function validateRemoteSession(name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name)) {
    throw new Error(`invalid remote session name: ${name}`);
  }
  return name;
}

export function machineEnabled(machine: SavedMachine): boolean {
  return machine.enabled !== false;
}

export function sshTarget(machine: Pick<SavedMachine, "user" | "host">): string {
  const host = machine.host.includes(":") ? `[${machine.host}]` : machine.host;
  return machine.user ? `${machine.user}@${host}` : host;
}

export function addMachine(
  file: SavedMachineFile,
  label: string,
  target: string,
  port?: number,
  options: { remoteSession?: string | null } = {},
): { file: SavedMachineFile; machine: SavedMachine } {
  const normalizedLabel = validateMachineLabel(label);
  if (file.machines.some((machine) =>
    machine.label.toLowerCase() === normalizedLabel.toLowerCase()
  )) {
    throw new Error(`machine already exists: ${normalizedLabel}`);
  }
  const destination = parseSshDestination(target);
  const resolvedPort = port ?? destination.port ?? 22;
  if (!Number.isInteger(resolvedPort) || resolvedPort < 1 || resolvedPort > 65535) {
    throw new Error("SSH port must be an integer from 1 through 65535");
  }
  const nextNumber = file.machines.reduce(
    (maximum, machine) => Math.max(maximum, Number.parseInt(machine.id.slice(1), 10) || 0),
    0,
  ) + 1;
  const machine: SavedMachine = {
    id: `m${nextNumber}`,
    label: normalizedLabel,
    user: destination.user,
    host: destination.host,
    port: resolvedPort,
  };
  if (options.remoteSession) {
    machine.remoteSession = validateRemoteSession(options.remoteSession);
  }
  return {
    file: { version: 1, machines: [...file.machines, machine] },
    machine,
  };
}

/** Returns a copy of `file` with one machine relabelled, enabled, or
 * disabled. */
export function updateMachine(
  file: SavedMachineFile,
  labelOrId: string,
  change: { label?: string; enabled?: boolean },
): { file: SavedMachineFile; machine: SavedMachine } {
  const current = findMachine(file, labelOrId);
  const next: SavedMachine = { ...current };
  if (change.label !== undefined) {
    const label = validateMachineLabel(change.label);
    if (file.machines.some((machine) =>
      machine.id !== current.id &&
      machine.label.toLowerCase() === label.toLowerCase()
    )) {
      throw new Error(`machine already exists: ${label}`);
    }
    next.label = label;
  }
  if (change.enabled !== undefined) {
    if (change.enabled) delete next.enabled;
    else next.enabled = false;
  }
  return {
    file: {
      version: 1,
      machines: file.machines.map((machine) =>
        machine.id === current.id ? next : machine
      ),
    },
    machine: next,
  };
}

export function removeMachine(
  file: SavedMachineFile,
  labelOrId: string,
): { file: SavedMachineFile; removed: SavedMachine } {
  const machine = findMachine(file, labelOrId);
  return {
    file: {
      version: 1,
      machines: file.machines.filter((entry) => entry.id !== machine.id),
    },
    removed: machine,
  };
}

export function findMachine(
  file: SavedMachineFile,
  labelOrId: string,
): SavedMachine {
  const wanted = labelOrId.trim().toLowerCase();
  const machine = file.machines.find((entry) => entry.id === labelOrId) ??
    file.machines.find((entry) => entry.label.toLowerCase() === wanted);
  if (!machine) throw new Error(`unknown machine: ${labelOrId}`);
  return machine;
}

function isSavedMachine(value: unknown): value is SavedMachine {
  if (typeof value !== "object" || value === null) return false;
  const machine = value as Partial<SavedMachine>;
  return typeof machine.id === "string" &&
    typeof machine.label === "string" &&
    (machine.user === null || typeof machine.user === "string") &&
    typeof machine.host === "string" &&
    typeof machine.port === "number" &&
    (machine.enabled === undefined || typeof machine.enabled === "boolean") &&
    (machine.remoteSession === undefined || machine.remoteSession === null ||
      typeof machine.remoteSession === "string");
}
