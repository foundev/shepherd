/** `shepherd --remote <target>`: the local UI attached to a daemon on
 * another machine through ssh and `shepherd server bridge`. */
import { spawn } from "node:child_process";
import { ClientConnection } from "../client/connection.js";
import { bindCommands, buildKeymap } from "../config/keybinds.js";
import type { LoadedConfig, ShepherdConfig } from "../config/model.js";
import { sshTarget } from "../machines.js";
import { openChildBridge, type ChildStream } from "./bridge.js";
import {
  bridgeCommand,
  discoverRemoteShepherd,
  installInstructions,
} from "./remoteCommand.js";
import {
  closeControlMaster,
  sshInvocation,
  type SshEndpoint,
  type SshOptions,
  type SshPaths,
} from "./ssh.js";

export type RemoteKeybindings = "local" | "server";

export function parseRemoteKeybindings(value: unknown): RemoteKeybindings {
  if (value === undefined || value === null || value === "local") return "local";
  if (value === "server") return "server";
  throw new Error("--remote-keybindings must be local or server");
}

/** Shown instead of a stack trace when setup cannot continue. */
export class RemoteSetupError extends Error {}

export interface RemoteKeys {
  prefix: string;
  bindings: ShepherdConfig["keys"]["bindings"];
  navigate: ShepherdConfig["keys"]["navigate"];
  commands: ShepherdConfig["keys"]["commands"];
}

/** The config a remote attach runs with. Local keybindings drop custom
 * command keys, since those commands would run on the remote host; server
 * keybindings take the remote daemon's keys, commands included. */
export function remoteLoadedConfig(
  local: LoadedConfig,
  mode: RemoteKeybindings,
  remoteKeys: RemoteKeys | null,
): LoadedConfig {
  const config = structuredClone(local.config);
  const diagnostics = [...local.diagnostics];
  if (mode === "server" && remoteKeys) {
    config.keys = {
      prefix: remoteKeys.prefix,
      bindings: remoteKeys.bindings,
      navigate: remoteKeys.navigate,
      commands: remoteKeys.commands,
    };
  } else {
    config.keys.commands = [];
  }
  const keymap = bindCommands(
    buildKeymap(config.keys.prefix, config.keys.bindings, diagnostics),
    config.keys.commands.map((command) => command.key),
    diagnostics,
  );
  return { ...local, config, keymap, diagnostics };
}

export interface RemoteAttachSession {
  connection: ClientConnection;
  /** Fetches the server keymap (server mode); null if unsupported. */
  fetchRemoteKeys: () => Promise<RemoteKeys | null>;
  close: () => Promise<void>;
}

/** Checks the remote install, opens the first bridge (allowing ssh to
 * prompt), and returns a connection that re-spawns ssh with backoff when
 * the bridge drops. */
export async function openRemoteAttach(options: {
  endpoint: SshEndpoint;
  session: string | null;
  manageSshConfig: boolean;
}): Promise<RemoteAttachSession> {
  const { endpoint } = options;
  const interactive: SshOptions = {
    manage: options.manageSshConfig,
    control: "private",
    batch: false,
  };
  const discovery = await discoverRemoteShepherd(endpoint, interactive, 120_000);
  if (discovery.status === "missing") {
    throw new RemoteSetupError(installInstructions(endpoint));
  }
  if (discovery.status === "ssh-error") {
    throw new RemoteSetupError(
      `cannot reach ${sshTarget(endpoint)} over ssh: ${discovery.message}\n` +
      `Check that \`ssh ${sshTarget(endpoint)}\` works, then retry.`,
    );
  }
  const executable = discovery.path;
  let paths: SshPaths = { configFile: null, controlPath: null };
  const open = async (batch: boolean): Promise<ChildStream> => {
    const invocation = sshInvocation(
      endpoint,
      bridgeCommand(executable, options.session),
      { ...interactive, batch, tty: "disable" },
    );
    paths = invocation.paths;
    const child = spawn(invocation.command, invocation.args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    return openChildBridge(child, 30_000);
  };
  let first: ChildStream;
  try {
    first = await open(false);
  } catch (error) {
    throw new RemoteSetupError(
      `remote Shepherd bridge on ${sshTarget(endpoint)} failed: ` +
      (error instanceof Error ? error.message : String(error)),
    );
  }
  // Reconnects never prompt: they would draw over the UI.
  const connection = ClientConnection.open(
    first,
    undefined,
    () => open(true),
    { initialDelayMs: 500, maxDelayMs: 30_000 },
  );
  return {
    connection,
    fetchRemoteKeys: async () => {
      try {
        const keys = await connection.request({ type: "config.keymap" }, 10_000) as RemoteKeys;
        return typeof keys?.prefix === "string" ? keys : null;
      } catch {
        return null;
      }
    },
    close: async () => {
      connection.close();
      await closeControlMaster(endpoint, paths);
    },
  };
}
