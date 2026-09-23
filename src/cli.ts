import net from "node:net";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { Command, CommanderError } from "commander";
import { render } from "ink";
import React from "react";
import { App } from "./client/App.js";
import { ClientConnection } from "./client/connection.js";
import { ScreenWriter } from "./client/screenWriter.js";
import { loadConfig } from "./config/model.js";
import { DEFAULT_CONFIG_TEXT } from "./config/defaultText.js";
import { decodeStream, encodeMessage } from "./protocol.js";
import { connect, ensureDaemon, socketPath } from "./transport.js";
import { apiSchema } from "./apiSchema.js";
import { stateDirectory } from "./server/persistence.js";
import {
  checkoutGithubPlugin,
  managedPluginPath,
  parseGithubPluginSource,
  pluginManifestRoot,
  reloadManifestAfterBuild,
  replaceManagedPlugin,
} from "./server/pluginInstall.js";
import {
  assertPluginCompatible,
  loadPluginManifest,
  runPluginBuilds,
} from "./server/plugins.js";
import {
  inspectMarketplaceRepository,
  loadMarketplaceCache,
  saveMarketplaceCache,
  searchPluginMarketplace,
} from "./server/pluginMarketplace.js";
import {
  addMachine,
  findMachine,
  loadMachines,
  machineEnabled,
  parseSshDestination,
  removeMachine,
  saveMachines,
  updateMachine,
  type SavedMachine,
} from "./machines.js";
import {
  openRemoteAttach,
  parseRemoteKeybindings,
  remoteLoadedConfig,
  RemoteSetupError,
  type RemoteKeys,
} from "./remote/attach.js";
import { runBridgeServer } from "./remote/bridge.js";
import {
  discoverRemoteShepherd,
  installInstructions,
  rememberExecutable,
  runProcess,
  runShepherdOnMachine,
  shepherdCommand,
} from "./remote/remoteCommand.js";
import { sshInvocation, type SshEndpoint } from "./remote/ssh.js";
import type { LoadedConfig } from "./config/model.js";
import type {
  AgentTaskPatch,
  ShepherdRequest,
  ShepherdResponse,
  StateView,
} from "./types.js";

const program = new Command();
// Throw instead of exiting on parse errors so usage errors exit with
// status 2, as in Shepherd. Must precede subcommand creation to be inherited.
program.exitOverride();

program
  .name("shepherd")
  .description("A modern React-based terminal runtime for coding agents")
  .option("-s, --session <name>", "daemon session", "default")
  .option("--socket <path>", "override daemon socket path")
  .option(
    "--remote <ssh-target>",
    "attach the local UI to Shepherd on another machine over SSH (host, user@host, or ssh://user@host:port)",
  )
  .option(
    "--remote-keybindings <local|server>",
    "keybindings for --remote: local (default) or the remote server's",
  )
  .hook("preAction", (command) => {
    const socketOverride = topCommand(command).getOptionValue("socket");
    if (typeof socketOverride === "string" && socketOverride) {
      process.env.SHEPHERD_SOCKET_PATH = socketOverride;
    }
  });

const api = program.command("api").description("raw socket API tools");

program.command("config")
  .description("configuration tools")
  .command("template")
  .description("print an annotated configuration template")
  .action(() => { process.stdout.write(DEFAULT_CONFIG_TEXT); });

api
  .command("schema")
  .option("--json", "print the complete schema as JSON", false)
  .action((options: { json: boolean }) => {
    if (options.json) {
      process.stdout.write(`${JSON.stringify(apiSchema, null, 2)}\n`);
      return;
    }
    process.stdout.write(
      `Shepherd API\nprotocol: ${apiSchema.protocolVersion}\nschema: ${apiSchema.schemaVersion}\ntransport: ${apiSchema.transport}\nmethods: ${apiSchema.methods.length}\n\n` +
      apiSchema.methods.map((method) =>
        `${method.name}(${Object.entries(method.params)
          .map(([key, value]) => `${key}: ${value}`)
          .join(", ")})`
      ).join("\n") + "\n",
    );
  });

api
  .command("request <json>")
  .action(async (json: string, _options: unknown, command: Command) => {
    const request = JSON.parse(json) as ShepherdRequest;
    if (typeof request.type !== "string") {
      throw new Error("API request JSON must include type");
    }
    const result = await requestOnce(sessionFor(command), request, 30_000);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });

program
  .command("attach", { isDefault: true })
  .description("attach to the persistent terminal UI")
  .option(
    "--remote <ssh-target>",
    "attach to Shepherd on another machine over SSH",
  )
  .option(
    "--remote-keybindings <local|server>",
    "keybindings for --remote: local (default) or the remote server's",
  )
  .action(async (options: { remote?: string; remoteKeybindings?: string }) => {
    const top = program.opts<{ remote?: string; remoteKeybindings?: string }>();
    const remote = options.remote ?? top.remote;
    const keybindings = options.remoteKeybindings ?? top.remoteKeybindings;
    if (remote) {
      const destination = parseSshDestination(remote);
      await attachRemote(
        { user: destination.user, host: destination.host, port: destination.port },
        explicitSession(),
        parseRemoteKeybindings(keybindings),
      );
      return;
    }
    if (keybindings !== undefined) {
      throw new Error("--remote-keybindings needs --remote");
    }
    const socket = await ensureDaemon(globalSession());
    const connection = ClientConnection.open(
      socket,
      undefined,
      () => ensureDaemon(globalSession()),
    );
    await runAttachedUi(connection, loadConfig(), () => loadConfig());
  });

/** Renders the UI on `connection` until the user detaches. */
async function runAttachedUi(
  connection: ClientConnection,
  loaded: LoadedConfig,
  reloadConfig: () => LoadedConfig,
): Promise<void> {
  // Draw on the alternate screen so the UI owns the whole terminal and the
  // user's scrollback is restored on detach.
  // Save the window title (XTWINOPS 22) so detaching restores it.
  process.stdout.write("\x1b[22;0t\x1b[?1049h\x1b[H\x1b[2J");
  const leaveAlternateScreen = () =>
    process.stdout.write("\x1b[?25h\x1b[?1049l\x1b[23;0t");
  process.once("exit", leaveAlternateScreen);
  // Ink renders frames into the screen writer (debug mode hands it each
  // full frame), which rewrites only changed rows on the host terminal.
  const screenWriter = new ScreenWriter(process.stdout);
  const instance = render(
    React.createElement(App, { connection, config: loaded, reloadConfig }),
    {
      stdout: screenWriter as unknown as NodeJS.WriteStream,
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  await instance.waitUntilExit().finally(() => {
    connection.close();
    screenWriter.dispose();
    leaveAlternateScreen();
    process.removeListener("exit", leaveAlternateScreen);
  });
}

/** `--remote`: checks the remote install, bridges to its daemon over ssh,
 * and runs the local UI on that connection. */
async function attachRemote(
  endpoint: SshEndpoint,
  session: string | null,
  keybindings: "local" | "server",
): Promise<void> {
  const local = loadConfig();
  process.stderr.write(`connecting to ${endpoint.user ? `${endpoint.user}@` : ""}${endpoint.host}…\n`);
  let remote;
  try {
    remote = await openRemoteAttach({
      endpoint,
      session,
      manageSshConfig: local.config.remote.manage_ssh_config,
    });
  } catch (error) {
    if (error instanceof RemoteSetupError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  let remoteKeys: RemoteKeys | null = null;
  if (keybindings === "server") {
    remoteKeys = await remote.fetchRemoteKeys();
    if (!remoteKeys) {
      process.stderr.write("remote server did not report its keybindings; using local keybindings\n");
    }
  }
  const configure = (loaded: LoadedConfig) => remoteLoadedConfig(loaded, keybindings, remoteKeys);
  await runAttachedUi(remote.connection, configure(local), () => {
    // The remote daemon reloads its own config too; pick up its new keys
    // for the next reload.
    if (keybindings === "server") {
      void remote.fetchRemoteKeys().then((keys) => {
        if (keys) remoteKeys = keys;
      });
    }
    return configure(loadConfig());
  });
  await remote.close();
}

const server = program.command("server").description("daemon management");

const session = program.command("session").description("named daemon sessions");

session.command("list").action(async () => {
  const sessions = await listSessions();
  process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
});

session
  .command("attach <name>")
  .action(async (name: string) => {
    requireValidSessionName(name);
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
    const isTypeScript = entry.endsWith(".ts");
    const args = isTypeScript
      ? ["--import", "tsx", entry, "--session", name, "attach"]
      : [entry, "--session", name, "attach"];
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    const exitCode = await new Promise<number | null>((resolve) => {
      child.once("error", () => resolve(127));
      child.once("exit", resolve);
    });
    process.exitCode = exitCode ?? 1;
  });

session
  .command("delete <name>")
  .option("--yes", "confirm deletion", false)
  .option("--stop", "stop a running daemon before deletion", false)
  .action(async (name: string, options: { yes: boolean; stop: boolean }) => {
    requireValidSessionName(name);
    const info = (await listSessions()).find((entry) => entry.name === name);
    if (!info) throw new Error(`unknown session: ${name}`);
    if (info.running && !options.stop) {
      throw new Error(`session ${name} is running; use --stop or stop it first`);
    }
    if (!options.yes) {
      if (!process.stdin.isTTY) throw new Error("noninteractive delete requires --yes");
      const confirmation = await readline.createInterface({
        input: process.stdin,
        output: process.stderr,
      }).question(`Delete session ${name} and its saved layout? [y/N] `);
      if (!/^\s*y(?:es)?\s*$/i.test(confirmation)) {
        throw new Error("session delete cancelled");
      }
    }
    if (info.running && options.stop) await stopSession(info.socketPath);
    fs.rmSync(path.dirname(info.socketPath), { recursive: true, force: true });
    process.stdout.write(
      `${JSON.stringify({ name, deleted: true })}\n`,
    );
  });

server
  .command("start")
  .description("start the detached daemon")
  .option("--foreground", "run in the foreground", false)
  .action(async (_options: unknown, command: Command) => {
    const foreground = command.getOptionValue("foreground") === true;
    const session = sessionFor(command);
    if (foreground) {
      const { ShepherdDaemon } = await import("./server/daemon.js");
      const daemon = new ShepherdDaemon({
        session,
        socketPath: socketPath(session),
      });
      await daemon.start();
      process.stdout.write(`shepherd daemon ready: ${socketPath(session)}\n`);
      return;
    }

    const socket = await ensureDaemon(session);
    socket.end();
    process.stdout.write(
      `${JSON.stringify({ ok: true, socket: socketPath(session) })}\n`,
    );
  });

server
  .command("handoff")
  .description("restart the daemon without stopping any pane (live handoff)")
  .action(async (_options: unknown, command: Command) => {
    const result = await requestOnce(sessionFor(command), {
      type: "server.live_handoff",
    }, 45_000);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });

server
  .command("status")
  .description("print daemon state as JSON")
  .action(async (_options: unknown, command: Command) => {
    const state = (await requestOnce(sessionFor(command), {
      type: "state.get",
    })) as StateView;
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  });

server.command("reload-config")
  .description("reload configuration in the running daemon")
  .action(async (_options: unknown, command: Command) => {
    process.stdout.write(`${JSON.stringify(await requestOnce(sessionFor(command), {
      type: "server.reload_config",
    }), null, 2)}\n`);
  });

server
  .command("bridge", { hidden: true })
  .description("pipe stdin/stdout to the daemon socket (used over ssh by --remote and saved machines)")
  .option("--idle-timeout <milliseconds>", "close after this long without traffic; 0 never", "0")
  .action(async (options: { idleTimeout: string }, command: Command) => {
    const idleTimeoutMs = Number.parseInt(options.idleTimeout, 10);
    if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 0) {
      throw new Error("--idle-timeout must be a non-negative integer");
    }
    // Nothing but protocol bytes may reach stdout from here on.
    const socket = await ensureDaemon(sessionFor(command));
    socket.setNoDelay(true);
    await runBridgeServer({
      socket,
      input: process.stdin,
      output: process.stdout,
      idleTimeoutMs,
    });
    process.stdout.write("", () => process.exit(0));
  });

server
  .command("stop")
  .description("stop the daemon and terminate its panes")
  .action(async (_options: unknown, command: Command) => {
    const result = await requestOnce(sessionFor(command), {
      type: "server.stop",
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });

const tab = program.command("tab").description("tab automation");

tab
  .command("list")
  .action(async (_options: unknown, command: Command) => {
    const state = (await requestOnce(sessionFor(command), {
      type: "state.get",
    })) as StateView;
    process.stdout.write(`${JSON.stringify(state.tabs, null, 2)}\n`);
  });

tab
  .command("new [name]")
  .option("-n, --name <name>")
  .action(async (name: string | undefined, options: { name?: string }, command: Command) => {
    const state = (await requestOnce(sessionFor(command), {
      type: "tab.create",
      name: name ?? options.name,
    })) as StateView;
    process.stdout.write(
      `${JSON.stringify(state.tabs.find((entry) => entry.id === state.activeTabId), null, 2)}\n`,
    );
  });

tab
  .command("use <tabId>")
  .action(async (tabId: string, _options: unknown, command: Command) => {
    process.stdout.write(
      `${JSON.stringify(await requestOnce(sessionFor(command), {
        type: "tab.select",
        tabId,
      }))}\n`,
    );
  });

tab
  .command("rename <tabId> <name>")
  .action(async (tabId: string, name: string, _options: unknown, command: Command) => {
    process.stdout.write(
      `${JSON.stringify(await requestOnce(sessionFor(command), {
        type: "tab.rename",
        tabId,
        name,
      }))}\n`,
    );
  });

const workspace = program
  .command("workspace")
  .description("workspace automation");

workspace
  .command("list")
  .action(async (_options: unknown, command: Command) => {
    const state = (await requestOnce(sessionFor(command), {
      type: "state.get",
    })) as StateView;
    process.stdout.write(`${JSON.stringify(state.workspaces, null, 2)}\n`);
  });

workspace
  .command("new [name]")
  .option("-n, --name <name>")
  .action(async (name: string | undefined, options: { name?: string }, command: Command) => {
    const state = (await requestOnce(sessionFor(command), {
      type: "workspace.create",
      name: name ?? options.name,
    })) as StateView;
    process.stdout.write(
      `${JSON.stringify(state.workspaces.find((entry) => entry.id === state.activeWorkspaceId), null, 2)}\n`,
    );
  });

workspace
  .command("use <workspaceId>")
  .action(async (workspaceId: string, _options: unknown, command: Command) => {
    process.stdout.write(
      `${JSON.stringify(await requestOnce(sessionFor(command), {
        type: "workspace.select",
        workspaceId,
      }))}\n`,
    );
  });

workspace
  .command("rename <workspaceId> <name>")
  .action(async (
    workspaceId: string,
    name: string,
    _options: unknown,
    command: Command,
  ) => {
    process.stdout.write(
      `${JSON.stringify(await requestOnce(sessionFor(command), {
        type: "workspace.rename",
        workspaceId,
        name,
      }))}\n`,
    );
  });

workspace
  .command("close <workspaceId>")
  .action(async (workspaceId: string, _options: unknown, command: Command) => {
    process.stdout.write(
      `${JSON.stringify(await requestOnce(sessionFor(command), {
        type: "workspace.close",
        workspaceId,
      }))}\n`,
    );
  });

const pane = program.command("pane").description("pane automation");

pane
  .command("list")
  .action(async (_options: unknown, command: Command) => {
    const state = (await requestOnce(sessionFor(command), {
      type: "state.get",
    })) as StateView;
    process.stdout.write(`${JSON.stringify(state.panes, null, 2)}\n`);
  });

pane
  .command("split")
  .option("-d, --direction <right|down>", "right", "right")
  .option("-c, --command <command>")
  .option("--cwd <directory>", "working directory for the pane", process.cwd())
  .option("--no-focus", "keep focus on the current pane")
  .action(async (
    options: {
      direction: "right" | "down";
      command?: string;
      cwd: string;
      focus: boolean;
    },
    command: Command,
  ) => {
    const state = (await requestOnce(sessionFor(command), {
      type: "pane.create",
      direction: options.direction,
      command: options.command,
      cwd: options.cwd,
      focus: options.focus,
    })) as StateView;
    process.stdout.write(
      `${JSON.stringify(state.panes[state.panes.length - 1], null, 2)}\n`,
    );
  });

pane
  .command("run <command...>")
  .option("--cwd <directory>", "working directory for the pane", process.cwd())
  .option("--no-focus", "keep focus on the current pane")
  .action(async (commandParts: string[], options: { cwd: string; focus: boolean }, command: Command) => {
    const state = (await requestOnce(sessionFor(command), {
      type: "pane.create",
      direction: "right",
      command: commandParts.join(" "),
      cwd: options.cwd,
      focus: options.focus,
    })) as StateView;
    process.stdout.write(
      `${JSON.stringify(state.panes[state.panes.length - 1], null, 2)}\n`,
    );
  });

pane
  .command("focus <paneId>")
  .action(async (paneId: string, _options: unknown, command: Command) => {
    process.stdout.write(
      `${JSON.stringify(await requestOnce(sessionFor(command), {
        type: "pane.focus",
        paneId,
      }))}\n`,
    );
  });

pane
  .command("rename <paneId> <title>")
  .action(async (paneId: string, title: string, _options: unknown, command: Command) => {
    process.stdout.write(
      `${JSON.stringify(await requestOnce(sessionFor(command), {
        type: "pane.rename",
        paneId,
        title,
      }))}\n`,
    );
  });

pane
  .command("zoom <paneId>")
  .option("-u, --unzoom", "exit zoom mode instead of zooming", false)
  .action(async (paneId: string, options: { unzoom: boolean }, command: Command) => {
    process.stdout.write(
      `${JSON.stringify(await requestOnce(sessionFor(command), {
        type: "pane.zoom",
        paneId,
        zoomed: !options.unzoom,
      }))}\n`,
    );
  });

pane
  .command("swap <paneId> <targetPaneId>")
  .action(async (
    paneId: string,
    targetPaneId: string,
    _options: unknown,
    command: Command,
  ) => {
    process.stdout.write(
      `${JSON.stringify(await requestOnce(sessionFor(command), {
        type: "pane.swap",
        paneId,
        targetPaneId,
      }))}\n`,
    );
  });

pane
  .command("move <paneId> <targetTabId>")
  .action(async (
    paneId: string,
    targetTabId: string,
    _options: unknown,
    command: Command,
  ) => {
    process.stdout.write(
      `${JSON.stringify(await requestOnce(sessionFor(command), {
        type: "pane.move",
        paneId,
        targetTabId,
      }))}\n`,
    );
  });

pane
  .command("resize-layout <paneId>")
  .requiredOption("--delta <number>", "ratio delta from -0.3 through 0.3")
  .action(async (paneId: string, options: { delta: string }, command: Command) => {
    process.stdout.write(
      `${JSON.stringify(await requestOnce(sessionFor(command), {
        type: "pane.resize-layout",
        paneId,
        delta: Number.parseFloat(options.delta),
      }))}\n`,
    );
  });

pane
  .command("scroll <paneId> <lines>")
  .action(async (paneId: string, lines: string, _options: unknown, command: Command) => {
    process.stdout.write(
      `${JSON.stringify(await requestOnce(sessionFor(command), {
        type: "pane.scroll",
        paneId,
        lines: Number.parseInt(lines, 10),
      }))}\n`,
    );
  });

pane
  .command("read <paneId>")
  .option("--rows <number>", "30", "30")
  .option(
    "--source <visible|recent|recent-unwrapped>",
    "visible",
    "visible",
  )
  .action(async (
    paneId: string,
    options: { rows: string; source: import("./types.js").ReadSource },
    command: Command,
  ) => {
    const snapshot = (await requestOnce(sessionFor(command), {
      type: "pane.snapshot",
      paneId,
      rows: Number.parseInt(options.rows, 10),
      source: options.source,
    })) as { lines: import("./types.js").TerminalLine[] };
    process.stdout.write(
      `${snapshot.lines.map((line) => line.map((span) => span.text).join("")).join("\n")}\n`,
    );
  });

pane
  .command("write <paneId> <text>")
  .action(async (paneId: string, text: string, _options: unknown, command: Command) => {
    process.stdout.write(
      `${JSON.stringify(await requestOnce(sessionFor(command), {
        type: "pane.input",
        paneId,
        data: `${text}\r`,
      }))}\n`,
    );
  });

pane
  .command("type <paneId> <text...>")
  .description("send text to a pane without pressing Enter")
  .action(async (paneId: string, words: string[], _options: unknown, command: Command) => {
    const result = await requestOnce(sessionFor(command), {
      type: "pane.input",
      paneId,
      data: words.join(" "),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  });

pane
  .command("wait-output <paneId> <text>")
  .description("wait until a pane's recent output contains text")
  .option("--timeout <milliseconds>", "maximum wait", "30000")
  .action(async (paneId: string, needle: string, options: { timeout: string }, command: Command) => {
    const timeout = Number.parseInt(options.timeout, 10);
    if (!Number.isInteger(timeout) || timeout < 0) throw new Error("--timeout must be a non-negative integer");
    const deadline = Date.now() + timeout;
    const session = sessionFor(command);
    while (true) {
      const snapshot = await requestOnce(session, {
        type: "pane.snapshot", paneId, rows: 200, source: "recent-unwrapped",
      }) as { lines: import("./types.js").TerminalLine[] };
      const output = snapshot.lines.map((line) => line.map((span) => span.text).join("")).join("\n");
      if (output.includes(needle)) {
        process.stdout.write(`${JSON.stringify({ paneId, found: true, text: needle })}\n`);
        return;
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${JSON.stringify(needle)} in ${paneId}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });

pane
  .command("close <paneId>")
  .action(async (paneId: string, _options: unknown, command: Command) => {
    process.stdout.write(
      `${JSON.stringify(await requestOnce(sessionFor(command), {
        type: "pane.close",
        paneId,
      }))}\n`,
    );
  });

const layout = program.command("layout").description("layout import and export");

layout
  .command("export [tabId]")
  .action(async (tabId: string | undefined, _options: unknown, command: Command) => {
    const result = await requestOnce(sessionFor(command), {
      type: "layout.export",
      tabId,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });

layout
  .command("apply [tabId] <file>")
  .action(async (
    tabId: string | undefined,
    file: string,
    _options: unknown,
    command: Command,
  ) => {
    const value = JSON.parse(fs.readFileSync(path.resolve(file), "utf8")) as {
      layout?: import("./types.js").LayoutNode;
    };
    if (!value.layout) throw new Error("layout file is missing layout");
    const result = await requestOnce(sessionFor(command), {
      type: "layout.apply",
      tabId,
      layout: value.layout,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });

const worktree = program
  .command("worktree")
  .description("Git worktree automation");

worktree
  .command("list [root]")
  .action(async (root: string | undefined, _options: unknown, command: Command) => {
    const result = await requestOnce(sessionFor(command), {
      type: "worktree.list",
      root,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });

worktree
  .command("create <root> <path> <branch>")
  .option("--existing-branch", "use an existing branch instead of creating one", false)
  .option("--start-point <commit-ish>")
  .action(async (
    root: string,
    target: string,
    branch: string,
    options: { existingBranch: boolean; startPoint?: string },
    command: Command,
  ) => {
    const result = await requestOnce(sessionFor(command), {
      type: "worktree.create",
      root,
      path: target,
      branch,
      createBranch: !options.existingBranch,
      startPoint: options.startPoint,
    }, 30_000);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });

worktree
  .command("open <path>")
  .option("-n, --name <name>")
  .action(async (target: string, options: { name?: string }, command: Command) => {
    const result = await requestOnce(sessionFor(command), {
      type: "worktree.open",
      path: target,
      name: options.name,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });

worktree
  .command("remove <root> <path>")
  .option("-f, --force", "force removal of dirty worktrees", false)
  .action(async (
    root: string,
    target: string,
    options: { force: boolean },
    command: Command,
  ) => {
    const result = await requestOnce(sessionFor(command), {
      type: "worktree.remove",
      root,
      path: target,
      force: options.force,
    }, 30_000);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });

const agent = program.command("agent").description("agent inspection");
const task = program.command("task").description("persistent task context for the agent desk");
task.command("get <paneId>").action(async (paneId: string, _options: unknown, command: Command) => {
  process.stdout.write(`${JSON.stringify(await requestOnce(sessionFor(command), { type: "task.get", paneId }), null, 2)}\n`);
});
task.command("changes <paneId>").description("list the pane checkout's changed files")
  .action(async (paneId: string, _options: unknown, command: Command) => {
    process.stdout.write(`${JSON.stringify(await requestOnce(sessionFor(command), { type: "task.changes", paneId }), null, 2)}\n`);
  });
task.command("update <paneId>")
  .option("--title <text>", "task objective; changing it resets previous results")
  .option("--summary <text>", "progress or result summary")
  .option("--next <text>", "next action")
  .option("--blocker <text>", "what needs attention; empty text clears it")
  .option("--checks <status>", "unknown, running, passed, or failed")
  .option("--check-summary <text>", "check command and result")
  .option("--review <state>", "none, requested, or reviewed")
  .option("--source <name>", "report author", "user")
  .option("--if-revision <number>", "reject if the task changed")
  .action(async (paneId: string, options: Record<string, string | undefined>, command: Command) => {
    const patch: AgentTaskPatch = {};
    for (const [option, field] of Object.entries({ title: "title", summary: "summary", next: "nextAction", blocker: "blocker", checks: "checkStatus", checkSummary: "checkSummary", review: "review" })) {
      if (options[option] !== undefined) Object.assign(patch, { [field]: options[option] });
    }
    const revision = options.ifRevision === undefined ? undefined : Number(options.ifRevision);
    if (revision !== undefined && (!Number.isInteger(revision) || revision < 0)) throw new Error("--if-revision must be a non-negative integer");
    process.stdout.write(`${JSON.stringify(await requestOnce(sessionFor(command), {
      type: "task.update", paneId, patch, source: options.source, expectedRevision: revision,
    }), null, 2)}\n`);
  });
agent.command("send <target> <text...>")
  .description("send an instruction to an idle agent and record its task")
  .action(async (target: string, text: string[], _options: unknown, command: Command) => {
    const session = sessionFor(command), pane = await resolvePane(session, target);
    process.stdout.write(`${JSON.stringify(await requestOnce(session, { type: "agent.send", paneId: pane.id, text: text.join(" ") }), null, 2)}\n`);
  });
agent.command("report <paneId> <state>")
  .description("report agent state; refresh before its lease expires")
  .requiredOption("--agent <name>", "agent identifier")
  .option("--source <name>", "integration identifier", "cli")
  .option("--ttl <milliseconds>", "status lease, 1000 to 3600000 ms", "120000")
  .action(async (paneId: string, state: string, options: { agent: string; source: string; ttl: string }, command: Command) => {
    if (!["idle", "working", "blocked", "unknown"].includes(state)) throw new Error("invalid agent state");
    process.stdout.write(`${JSON.stringify(await requestOnce(sessionFor(command), {
      type: "pane.report_agent", paneId, agent: options.agent, source: options.source,
      state: state as "idle" | "working" | "blocked" | "unknown", ttlMs: Number(options.ttl),
    }), null, 2)}\n`);
  });

agent
  .command("manifests")
  .description("print the built-in agent detection rules")
  .action(async (_options: unknown, command: Command) => {
    process.stdout.write(
      `${JSON.stringify(await requestOnce(sessionFor(command), {
        type: "agent.manifests",
      }))}\n`,
    );
  });

const events = program.command("events").description("runtime event stream");

const machine = program.command("machine").description("saved SSH machines");

machine
  .command("add <target> [legacyTarget]")
  .description(
    "save an SSH machine: `machine add <ssh-target> --label L [--remote-session NAME]` " +
    "(checks the remote install first), or the older `machine add <label> <ssh-target>`",
  )
  .option("--label <label>", "label shown in the sidebar")
  .option("--remote-session <name>", "Shepherd session on the remote machine")
  .option("-p, --port <number>", "SSH port (default 22, or the port in an ssh:// target)")
  .option("--no-verify", "save without checking the remote install")
  .action(async (
    first: string,
    legacyTarget: string | undefined,
    options: { label?: string; remoteSession?: string; port?: string; verify: boolean },
    command: Command,
  ) => {
    const port = options.port === undefined ? undefined : Number.parseInt(options.port, 10);
    if (legacyTarget !== undefined) {
      // Older positional form: `machine add <label> <target>`, saved as is.
      if (options.label !== undefined) {
        throw new Error("use either `machine add <label> <target>` or `machine add <target> --label L`");
      }
      const result = addMachine(loadMachines(), first, legacyTarget, port ?? 22, {
        remoteSession: options.remoteSession,
      });
      saveMachines(result.file);
      await notifyMachineChange(command);
      process.stdout.write(`${JSON.stringify(result.machine, null, 2)}\n`);
      return;
    }
    if (!options.label) throw new Error("machine add needs --label <label>");
    const result = addMachine(loadMachines(), options.label, first, port, {
      remoteSession: options.remoteSession,
    });
    if (options.verify) {
      const ready = await prepareMachine(result.machine);
      if (!ready) {
        process.exitCode = 1;
        return;
      }
    }
    saveMachines(result.file);
    await notifyMachineChange(command);
    process.stdout.write(`${JSON.stringify(result.machine, null, 2)}\n`);
  });

machine
  .command("list")
  .option("--json", "print JSON (the default)", false)
  .action(() => {
    process.stdout.write(
      `${JSON.stringify(loadMachines().machines.map(machineRecord), null, 2)}\n`,
    );
  });

machine
  .command("remove <labelOrId>")
  .action(async (labelOrId: string, _options: unknown, command: Command) => {
    const result = removeMachine(loadMachines(), labelOrId);
    saveMachines(result.file);
    await notifyMachineChange(command);
    process.stdout.write(`${JSON.stringify(result.removed, null, 2)}\n`);
  });

machine
  .command("rename <labelOrId>")
  .requiredOption("--label <label>", "new label")
  .action(async (labelOrId: string, options: { label: string }, command: Command) => {
    await changeMachine(command, labelOrId, { label: options.label });
  });

machine
  .command("enable <labelOrId>")
  .action(async (labelOrId: string, _options: unknown, command: Command) => {
    await changeMachine(command, labelOrId, { enabled: true });
  });

machine
  .command("disable <labelOrId>")
  .description("keep the machine but close its connection")
  .action(async (labelOrId: string, _options: unknown, command: Command) => {
    await changeMachine(command, labelOrId, { enabled: false });
  });

machine
  .command("status <labelOrId>")
  .description("print the remote daemon state")
  .action(async (labelOrId: string) => {
    const result = await runShepherdOnMachine(
      findMachine(loadMachines(), labelOrId),
      ["server", "status"],
      { manage: loadConfig().config.remote.manage_ssh_config, capture: true },
    );
    if (result.status !== "ran") {
      process.stderr.write(`${result.message}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(result.stdout);
    if (result.exitCode !== 0 && result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.exitCode === 0 ? 0 : 1;
  });

machine
  .command("exec <labelOrId> <args...>")
  .description("run a Shepherd command on a saved machine; use -- before remote options")
  .allowUnknownOption()
  .action(async (labelOrId: string, args: string[]) => {
    const entry = findMachine(loadMachines(), labelOrId);
    if (!machineEnabled(entry)) throw new Error(`machine ${entry.label} is disabled`);
    const result = await runShepherdOnMachine(entry, args, {
      manage: loadConfig().config.remote.manage_ssh_config,
      capture: false,
    });
    if (result.status !== "ran") throw new Error(result.message);
    process.exitCode = result.exitCode;
  });

machine
  .command("run <labelOrId> <command...>")
  .description("run a shell command on the machine")
  .action(async (labelOrId: string, commandParts: string[]) => {
    const machineEntry = findMachine(loadMachines(), labelOrId);
    const { command, args } = sshInvocation(
      machineEndpoint(machineEntry),
      commandParts.join(" "),
      {
        manage: loadConfig().config.remote.manage_ssh_config,
        control: "shared",
        batch: !process.stdin.isTTY,
        tty: "disable",
      },
    );
    const result = await runProcess(command, args, 10 * 60_000);
    process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.exitCode === 0 ? 0 : 1;
  });


machine
  .command("agent-read <labelOrId> <target>")
  .option("--rows <number>", "80", "80")
  .option("--source <visible|recent|recent-unwrapped>", "recent-unwrapped", "recent-unwrapped")
  .action(async (
    labelOrId: string,
    target: string,
    options: { rows: string; source: import("./types.js").ReadSource },
    command: Command,
  ) => {
    const result = (await requestOnce(sessionFor(command), {
      type: "machine.agent-read",
      labelOrId,
      target,
      rows: Number.parseInt(options.rows, 10),
      source: options.source,
    }, 35_000)) as import("./types.js").RemoteAgentOperationResult;
    process.stdout.write(`${result.value}\n`);
  });

machine
  .command("pane-read <labelOrId> <paneId>")
  .option("--rows <number>", "80", "80")
  .option("--source <visible|recent|recent-unwrapped>", "recent-unwrapped", "recent-unwrapped")
  .action(async (
    labelOrId: string,
    paneId: string,
    options: { rows: string; source: import("./types.js").ReadSource },
    command: Command,
  ) => {
    const result = (await requestOnce(sessionFor(command), {
      type: "machine.pane-read",
      labelOrId,
      paneId,
      rows: Number.parseInt(options.rows, 10),
      source: options.source,
    }, 35_000)) as { value: string };
    process.stdout.write(`${result.value}\n`);
  });

machine
  .command("pane-write <labelOrId> <paneId> <text>")
  .action(async (
    labelOrId: string,
    paneId: string,
    text: string,
    _options: unknown,
    command: Command,
  ) => {
    const result = (await requestOnce(sessionFor(command), {
      type: "machine.pane-input",
      labelOrId,
      paneId,
      data: text,
    }, 25_000)) as { value: string };
    process.stdout.write(`${result.value}\n`);
  });

machine
  .command("agent-prompt <labelOrId> <target> <prompt...>")
  .option("--timeout <milliseconds>", "120000", "120000")
  .action(async (
    labelOrId: string,
    target: string,
    prompt: string[],
    options: { timeout: string },
    command: Command,
  ) => {
    const result = (await requestOnce(sessionFor(command), {
      type: "machine.agent-prompt",
      labelOrId,
      target,
      prompt: prompt.join(" "),
      timeoutMs: Number.parseInt(options.timeout, 10),
    }, Number.parseInt(options.timeout, 10) + 15_000)) as import("./types.js").RemoteAgentOperationResult;
    process.stdout.write(`${result.value}\n`);
  });

machine
  .command("attach <labelOrId>")
  .description("attach the local UI to Shepherd on a saved SSH machine (like --remote)")
  .option("--remote-keybindings <local|server>", "local (default) or the remote server's")
  .action(async (labelOrId: string, options: { remoteKeybindings?: string }) => {
    const machineEntry = findMachine(loadMachines(), labelOrId);
    await attachRemote(
      machineEndpoint(machineEntry),
      machineEntry.remoteSession ?? null,
      parseRemoteKeybindings(options.remoteKeybindings),
    );
  });

events
  .command("wait [event]")
  .option("--timeout <milliseconds>", "30000", "30000")
  .action(async (
    event: string | undefined,
    options: { timeout: string },
    command: Command,
  ) => {
    const result = await requestOnce(
      sessionFor(command),
      {
        type: "events.wait",
        event: event ?? "state.changed",
        timeoutMs: Number.parseInt(options.timeout, 10),
      },
      Number.parseInt(options.timeout, 10) + 1_000,
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });

events.command("listen").action(async (_options: unknown, command: Command) => {
  const socket = await ensureDaemon(sessionFor(command));
  const connection = ClientConnection.open(socket, (event) => {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  });
  await connection.request({ type: "events.subscribe" });
  const close = () => {
    connection.close();
    process.exit(0);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  await new Promise(() => {});
});

agent.command("list").action(async (_options: unknown, command: Command) => {
  const state = (await requestOnce(sessionFor(command), {
    type: "state.get",
  })) as StateView;
  process.stdout.write(
      `${JSON.stringify(state.panes.filter((entry) => entry.agent), null, 2)}\n`,
  );
});

agent
  .command("get <target>")
  .action(async (target: string, _options: unknown, command: Command) => {
    const pane = await resolvePane(sessionFor(command), target);
    process.stdout.write(`${JSON.stringify(pane, null, 2)}\n`);
  });

const plugin = program.command("plugin").description("local plugin management");

plugin.command("list").action(async (_options: unknown, command: Command) => {
  const state = (await requestOnce(sessionFor(command), {
    type: "state.get",
  })) as StateView;
  process.stdout.write(`${JSON.stringify(state.plugins, null, 2)}\n`);
});

plugin
  .command("search [query]")
  .description("search public GitHub repositories tagged shepherd-plugin")
  .option("--limit <number>", "25", "25")
  .action(async (
    query: string | undefined,
    options: { limit: string },
    command: Command,
  ) => {
    const session = sessionFor(command);
    const result = await searchPluginMarketplace(
      query ?? "",
      Number.parseInt(options.limit, 10),
    );
    saveMarketplaceCache(stateDirectory(session), {
      version: 1,
      updatedAt: new Date().toISOString(),
      query: query ?? "",
      total: result.total,
      plugins: result.plugins,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });

const marketplace = plugin
  .command("marketplace")
  .description("cached marketplace catalog");

marketplace.command("list").action(async (_options: unknown, command: Command) => {
  const cache = loadMarketplaceCache(stateDirectory(sessionFor(command)));
  process.stdout.write(`${JSON.stringify(cache, null, 2)}\n`);
});

marketplace
  .command("refresh")
  .description("refresh and cache the GitHub shepherd-plugin catalog")
  .action(async (_options: unknown, command: Command) => {
    const result = await requestOnce(sessionFor(command), {
      type: "marketplace.refresh",
    }, 20_000);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });

plugin
  .command("preview <repository>")
  .description("inspect shepherd-plugin.toml files in a public GitHub repository")
  .option("-b, --branch <name>", "main", "main")
  .action(async (
    repository: string,
    options: { branch: string },
  ) => {
    const result = await inspectMarketplaceRepository(
      repository,
      options.branch,
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });

plugin
  .command("install <source>")
  .description("install a plugin from owner/repo[/subdir] GitHub shorthand")
  .option("--ref <reference>")
  .option("-y, --yes", "skip the interactive confirmation", false)
  .action(async (
    sourceArgument: string,
    options: { ref?: string; yes: boolean },
    command: Command,
  ) => {
    const session = sessionFor(command);
    const stateDir = stateDirectory(session);
    const source = parseGithubPluginSource(sourceArgument);
    const temporary = path.join(
      stateDir,
      "plugin-install",
      `${process.pid}-${Date.now()}`,
    );
    fs.mkdirSync(temporary, { recursive: true });

    try {
      const checkout = path.join(temporary, "checkout");
      const commit = await checkoutGithubPlugin(
        source,
        options.ref,
        checkout,
      );
      const manifestRoot = pluginManifestRoot(checkout, source);
      const manifest = loadPluginManifest(manifestRoot);
      process.stderr.write(
        `Install ${manifest.id} ${manifest.version} from ${source.owner}/${source.repo}${source.subdir ? `/${source.subdir}` : ""}@${commit}\n` +
        `Actions: ${manifest.actions.map((action) => action.id).join(", ") || "none"}\n` +
        `Builds: ${manifest.builds.map((build) => build.command.join(" ")).join("; ") || "none"}\n` +
        `Startup (runs whenever the server starts): ${manifest.startup.map((hook) => hook.command.join(" ")).join("; ") || "none"}\n` +
        `Event hooks: ${manifest.events.map((hook) => `${hook.on.join(",")} -> ${hook.command.join(" ")}`).join("; ") || "none"}\n` +
        `Panes: ${manifest.panes.map((pane) => `${pane.id} (${pane.placement}) -> ${pane.command.join(" ")}`).join("; ") || "none"}\n` +
        `Link handlers: ${manifest.linkHandlers.map((handler) => `${handler.pattern} -> ${handler.action}`).join("; ") || "none"}\n`,
      );
      assertPluginCompatible(manifest);

      if (!options.yes) {
        if (!process.stdin.isTTY) {
          throw new Error("noninteractive plugin install requires --yes");
        }
        const confirmation = await readline.createInterface({
          input: process.stdin,
          output: process.stderr,
        }).question("Run and install this plugin? [y/N] ");
        if (!/^\s*y(?:es)?\s*$/i.test(confirmation)) {
          throw new Error("plugin install cancelled");
        }
      }

      await runPluginBuilds(manifest);
      const finalManifest = reloadManifestAfterBuild(manifestRoot, manifest);
      const managedPath = managedPluginPath(stateDir, source);
      const state = (await requestOnce(session, {
        type: "state.get",
      })) as StateView;
      const existing = state.plugins.find((plugin) => plugin.id === finalManifest.id);
      if (existing) {
        const managedRoot = path.join(stateDir, "managed-plugins");
        if (!path.resolve(existing.manifestPath).startsWith(`${managedRoot}${path.sep}`)) {
          throw new Error(
            `plugin ${existing.id} is locally linked; unlink it before installing`,
          );
        }
        await requestOnce(session, {
          type: "plugin.unlink",
          pluginId: existing.id,
        });
      }
      replaceManagedPlugin(checkout, managedPath);
      const linked = await requestOnce(session, {
        type: "plugin.link",
        path: pluginManifestRoot(managedPath, source),
      });
      process.stdout.write(`${JSON.stringify(linked, null, 2)}\n`);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

plugin
  .command("link <path>")
  .description("link a local directory or shepherd-plugin.toml manifest")
  .action(async (inputPath: string, _options: unknown, command: Command) => {
    process.stdout.write(
      `${JSON.stringify(await requestOnce(sessionFor(command), {
        type: "plugin.link",
        path: inputPath,
      }), null, 2)}\n`,
    );
  });

plugin
  .command("unlink <pluginId>")
  .action(async (pluginId: string, _options: unknown, command: Command) => {
    process.stdout.write(
      `${JSON.stringify(await requestOnce(sessionFor(command), {
        type: "plugin.unlink",
        pluginId,
      }))}\n`,
    );
  });

plugin
  .command("enable <pluginId>")
  .action(async (pluginId: string, _options: unknown, command: Command) => {
    process.stdout.write(
      `${JSON.stringify(await requestOnce(sessionFor(command), {
        type: "plugin.set-enabled",
        pluginId,
        enabled: true,
      }))}\n`,
    );
  });

plugin
  .command("disable <pluginId>")
  .action(async (pluginId: string, _options: unknown, command: Command) => {
    process.stdout.write(
      `${JSON.stringify(await requestOnce(sessionFor(command), {
        type: "plugin.set-enabled",
        pluginId,
        enabled: false,
      }))}\n`,
    );
  });

plugin
  .command("invoke <pluginId> <actionId>")
  .action(async (
    pluginId: string,
    actionId: string,
    _options: unknown,
    command: Command,
  ) => {
    const result = (await requestOnce(sessionFor(command), {
      type: "plugin.action-invoke",
      pluginId,
      actionId,
    }, 35_000)) as {
      exitCode: number | null;
      stdout: string;
      stderr: string;
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.exitCode !== 0) process.exitCode = 1;
  });

plugin.command("uninstall <pluginId>")
  .description("remove a managed plugin")
  .action(async (pluginId: string, _options: unknown, command: Command) => {
    process.stdout.write(`${JSON.stringify(await requestOnce(sessionFor(command), {
      type: "plugin.uninstall", pluginId,
    }), null, 2)}\n`);
  });

plugin.command("config-dir <pluginId>")
  .action(async (pluginId: string, _options: unknown, command: Command) => {
    process.stdout.write(`${JSON.stringify(await requestOnce(sessionFor(command), {
      type: "plugin.config-dir", pluginId,
    }), null, 2)}\n`);
  });

plugin.command("logs [pluginId]")
  .option("--limit <number>", "maximum number of logs", "20")
  .action(async (pluginId: string | undefined, options: { limit: string }, command: Command) => {
    const limit = Number.parseInt(options.limit, 10);
    if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer");
    process.stdout.write(`${JSON.stringify(await requestOnce(sessionFor(command), {
      type: "plugin.log-list", pluginId, limit,
    }), null, 2)}\n`);
  });

const pluginPane = plugin.command("pane").description("manage plugin panes");
pluginPane.command("open <pluginId> <entrypointId>")
  .option("--placement <placement>", "overlay, popup, split, tab, or zoomed")
  .action(async (pluginId: string, entrypointId: string, options: { placement?: string }, command: Command) => {
    const placement = options.placement;
    if (placement && !["overlay", "popup", "split", "tab", "zoomed"].includes(placement)) {
      throw new Error("invalid placement");
    }
    process.stdout.write(`${JSON.stringify(await requestOnce(sessionFor(command), {
      type: "plugin.pane-open", pluginId, entrypointId,
      placement: placement as "overlay" | "popup" | "split" | "tab" | "zoomed" | undefined,
    }), null, 2)}\n`);
  });
pluginPane.command("focus <paneId>")
  .action(async (paneId: string, _options: unknown, command: Command) => {
    process.stdout.write(`${JSON.stringify(await requestOnce(sessionFor(command), {
      type: "plugin.pane-focus", paneId,
    }), null, 2)}\n`);
  });
pluginPane.command("close <paneId>")
  .action(async (paneId: string, _options: unknown, command: Command) => {
    process.stdout.write(`${JSON.stringify(await requestOnce(sessionFor(command), {
      type: "plugin.pane-close", paneId,
    }), null, 2)}\n`);
  });

const integration = program.command("integration").description("agent integration management");
integration.command("list")
  .action(async (_options: unknown, command: Command) => {
    process.stdout.write(`${JSON.stringify(await requestOnce(sessionFor(command), {
      type: "integration.list",
    }), null, 2)}\n`);
  });
for (const verb of ["install", "uninstall"] as const) {
  integration.command(`${verb} <target>`)
    .action(async (target: string, _options: unknown, command: Command) => {
      process.stdout.write(`${JSON.stringify(await requestOnce(sessionFor(command), {
        type: `integration.${verb}`, target,
      }), null, 2)}\n`);
    });
}

program.command("notify <title> [body]")
  .description("show a notification in an attached client")
  .action(async (title: string, body: string | undefined, _options: unknown, command: Command) => {
    process.stdout.write(`${JSON.stringify(await requestOnce(sessionFor(command), {
      type: "notification.show", title, body,
    }), null, 2)}\n`);
  });

agent
  .command("explain <target>")
  .description("show which detection rule decides an agent's status")
  .option("--json", "print the full explanation as JSON", false)
  .option("-v, --verbose", "list every rule that was evaluated", false)
  .action(async (
    target: string,
    options: { json: boolean; verbose: boolean },
    command: Command,
  ) => {
    const result = await requestOnce(sessionFor(command), {
      type: "agent.explain",
      target,
    }) as {
      agent: string | null;
      state: string;
      status?: string;
      manifest_source?: string;
      manifest_version?: string | null;
      matched_rule?: { id: string; region: string; priority: number } | null;
      fallback_reason?: string | null;
      warning?: string | null;
      visible_idle?: boolean;
      visible_blocker?: boolean;
      visible_working?: boolean;
      evaluated_rules?: Array<{
        id: string;
        priority: number;
        region: string;
        state: string;
        matched: boolean;
        evidence: { region_bytes: number; region_preview: string };
      }>;
    };
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    const lines = [
      `agent: ${result.agent ?? "none"}`,
      `state: ${result.state}${result.status ? ` (status ${result.status})` : ""}`,
      `manifest: ${result.manifest_source ?? "none"} ${result.manifest_version ?? "unknown"}`,
      result.matched_rule
        ? `rule: ${result.matched_rule.id} (region=${result.matched_rule.region} priority=${result.matched_rule.priority})`
        : "rule: none",
    ];
    const matched = result.evaluated_rules?.find((rule) => rule.id === result.matched_rule?.id);
    if (matched) lines.push(`evidence: ${JSON.stringify(matched.evidence.region_preview)}`);
    if (result.fallback_reason) lines.push(`fallback_reason: ${result.fallback_reason}`);
    if (result.warning) lines.push(`warning: ${result.warning}`);
    if (options.verbose) {
      lines.push(
        `visible: idle=${result.visible_idle} blocker=${result.visible_blocker} working=${result.visible_working}`,
        "evaluated_rules:",
      );
      for (const rule of result.evaluated_rules ?? []) {
        lines.push(
          `  ${rule.matched ? "✓" : "✗"} ${rule.id} priority=${rule.priority} region=${rule.region} state=${rule.state}`,
          `    region: bytes=${rule.evidence.region_bytes} preview=${JSON.stringify(rule.evidence.region_preview)}`,
        );
      }
    }
    process.stdout.write(`${lines.join("\n")}\n`);
  });

agent
  .command("read <target>")
  .option("--rows <number>", "30", "30")
  .option(
    "--source <visible|recent|recent-unwrapped>",
    "visible",
    "visible",
  )
  .action(async (
    target: string,
    options: { rows: string; source: import("./types.js").ReadSource },
    command: Command,
  ) => {
    const pane = await resolvePane(sessionFor(command), target);
    const snapshot = (await requestOnce(sessionFor(command), {
      type: "pane.snapshot",
      paneId: pane.id,
      rows: Number.parseInt(options.rows, 10),
      source: options.source,
    })) as { lines: import("./types.js").TerminalLine[] };
    process.stdout.write(`${renderTerminalLines(snapshot.lines)}\n`);
  });

agent
  .command("wait <target>")
  .option("--status <idle|working|blocked|done>", "idle", "idle")
  .option("--timeout <milliseconds>", "60000", "60000")
  .action(async (
    target: string,
    options: {
      status: "idle" | "working" | "blocked" | "done";
      timeout: string;
    },
    command: Command,
  ) => {
    const pane = await resolvePane(sessionFor(command), target);
    const result = await requestOnce(sessionFor(command), {
      type: "pane.wait",
      paneId: pane.id,
      statuses: [options.status],
      timeoutMs: Number.parseInt(options.timeout, 10),
    }, timeoutMargin(options.timeout));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if ((result as { timedOut?: boolean }).timedOut) process.exitCode = 1;
  });

agent
  .command("prompt <target> <text...>")
  .option("--timeout <milliseconds>", "120000", "120000")
  .action(async (
    target: string,
    text: string[],
    options: { timeout: string },
    command: Command,
  ) => {
    const session = sessionFor(command);
    const pane = await resolvePane(session, target);
    const timeout = Number(options.timeout);
    if (!Number.isInteger(timeout) || timeout < 0) throw new Error("--timeout must be a non-negative integer");
    if (!pane.agent) throw new Error(`no agent detected in ${pane.id}`);
    if (pane.status === "blocked") throw new Error(`agent ${pane.id} needs attention; inspect its output before sending a prompt`);
    const prompt = text.join(" ");

    await requestOnce(session, { type: "agent.send", paneId: pane.id, text: prompt });
    const activity = await requestOnce(session, {
      type: "pane.wait",
      paneId: pane.id,
      statuses: ["working", "blocked"],
      timeoutMs: Math.min(5_000, timeout),
    }, Math.min(5_000, timeout) + 1_000) as { status: string; timedOut: boolean };

    let settled = activity;
    if (activity.status === "working" && !activity.timedOut) {
      settled = await requestOnce(session, {
        type: "pane.wait",
        paneId: pane.id,
        statuses: ["idle", "blocked", "done"],
        timeoutMs: timeout,
      }, timeout + 1_000) as { status: string; timedOut: boolean };
    }

    process.stdout.write(
      `${JSON.stringify({ paneId: pane.id, prompt, ...settled }, null, 2)}\n`,
    );
    if (settled.timedOut) process.exitCode = 1;
  });

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError) {
    process.exitCode = error.exitCode === 0 ? 0 : 2;
  } else {
    process.stderr.write(
      `shepherd: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

function topCommand(command: Command): Command {
  let current: Command | null = command;
  while (current.parent) current = current.parent;
  return current;
}

function sessionFor(command: Command): string {
  const value = topCommand(command).getOptionValue("session");
  return typeof value === "string" && value ? value : "default";
}

function globalSession(): string {
  return program.getOptionValue("session") ?? "default";
}

async function resolvePane(session: string, target: string) {
  const state = (await requestOnce(session, {
    type: "state.get",
  })) as StateView;
  const byId = state.panes.find((pane) => pane.id === target);
  if (byId) return byId;
  const byAgent = state.panes.filter((pane) => pane.agent === target);
  if (byAgent.length === 1) return byAgent[0];
  if (byAgent.length > 1) {
    throw new Error(`multiple agents named ${target}; use a pane ID`);
  }
  throw new Error(`unknown agent or pane: ${target}`);
}

function renderTerminalLines(
  lines: import("./types.js").TerminalLine[],
): string {
  return lines
    .map((line) => line.map((span) => span.text).join(""))
    .join("\n");
}

async function requestOnce(
  session: string,
  request: ShepherdRequest,
  timeoutMs = 4_000,
): Promise<unknown> {
  const socket = await ensureDaemon(session);
  try {
    return await requestOnSocket(socket, request, timeoutMs);
  } finally {
    socket.end();
  }
}

async function requestOnSocket(
  socket: net.Socket,
  request: ShepherdRequest,
  timeoutMs = 4_000,
): Promise<unknown> {
  const id = `cli-${Math.random().toString(16).slice(2)}`;
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("request timed out"));
    }, timeoutMs);

    socket.setEncoding("utf8");
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const { messages, remainder } = decodeStream(buffer);
      buffer = remainder;
      const response = messages.find((message): message is ShepherdResponse => (
        "id" in message && "ok" in message && message.id === id
      ));
      if (!response) return;
      clearTimeout(timer);
      socket.end();
      if (response.ok) resolve(response.result);
      else reject(new Error(response.error));
    });
    socket.write(encodeMessage({ id, ...request }));
  });
}

function timeoutMargin(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return (Number.isFinite(parsed) ? parsed : 0) + 1_000;
}

interface SessionInfo {
  name: string;
  statePath: string;
  socketPath: string;
  running: boolean;
  serverPid: number | null;
  workspaces: number;
  panes: number;
}

async function listSessions(): Promise<SessionInfo[]> {
    const root = path.dirname(stateDirectory("default"));
  if (!fs.existsSync(root)) return [];
  const sessions: SessionInfo[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !validateSessionName(entry.name)) continue;
    const directory = path.join(root, entry.name);
    const stateFile = path.join(directory, "state.json");
    const daemonSocket = path.join(directory, "daemon.sock");
    if (!fs.existsSync(stateFile) && !fs.existsSync(daemonSocket)) continue;

    let running = false;
    let serverPid: number | null = null;
    let workspaces = 0;
    let panes = 0;
    if (fs.existsSync(daemonSocket)) {
      try {
        const socket = await connect(daemonSocket, 250);
        const connection = ClientConnection.open(socket);
        try {
          const state = await connection.request({
            type: "state.get",
          }, 500) as StateView;
          running = true;
          serverPid = state.serverPid;
          workspaces = state.workspaces.length;
          panes = state.panes.length;
        } finally {
          connection.close();
        }
      } catch {
        running = false;
      }
    }

    sessions.push({
      name: entry.name,
      statePath: stateFile,
      socketPath: daemonSocket,
      running,
      serverPid,
      workspaces,
      panes,
    });
  }
  return sessions.sort((left, right) => left.name.localeCompare(right.name));
}

async function stopSession(pathName: string): Promise<void> {
  const socket = await connect(pathName, 500);
  const connection = ClientConnection.open(socket);
  try {
    await connection.request({ type: "server.stop" }, 1_000);
  } finally {
    connection.close();
  }
}

function validateSessionName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name);
}

function requireValidSessionName(name: string): void {
  if (!validateSessionName(name)) {
    throw new Error("invalid session name");
  }
}

/** The session named with --session, or null when it was left at its
 * default (the remote side then uses its own default). */
function explicitSession(): string | null {
  return program.getOptionValueSource("session") === "default"
    ? null
    : globalSession();
}

function machineEndpoint(entry: SavedMachine): SshEndpoint {
  return { user: entry.user, host: entry.host, port: entry.port };
}

function machineRecord(entry: SavedMachine): SavedMachine {
  return {
    ...entry,
    enabled: machineEnabled(entry),
    remoteSession: entry.remoteSession ?? null,
  };
}

async function changeMachine(
  command: Command,
  labelOrId: string,
  change: { label?: string; enabled?: boolean },
): Promise<void> {
  const result = updateMachine(loadMachines(), labelOrId, change);
  saveMachines(result.file);
  await notifyMachineChange(command);
  process.stdout.write(`${JSON.stringify(machineRecord(result.machine), null, 2)}\n`);
}

/** Tells a running daemon to reread machines.json now (it also notices by
 * itself within a second). Never starts a daemon. */
async function notifyMachineChange(command: Command): Promise<void> {
  try {
    const socket = await connect(socketPath(sessionFor(command)), 300);
    await requestOnSocket(socket, { type: "machine.sync" }, 1_000);
  } catch {
    // No daemon running, or an older one: nothing to update.
  }
}

/** Checks that Shepherd is installed on a new machine and starts its
 * daemon, as `machine add` does before saving. Prints why not otherwise. */
async function prepareMachine(entry: SavedMachine): Promise<boolean> {
  const endpoint = machineEndpoint(entry);
  const manage = loadConfig().config.remote.manage_ssh_config;
  const discovery = await discoverRemoteShepherd(
    endpoint,
    { manage, control: "shared", batch: !process.stdin.isTTY },
    120_000,
  );
  if (discovery.status === "missing") {
    process.stderr.write(`${installInstructions(endpoint)}\n\nThe machine was not saved.\n`);
    return false;
  }
  if (discovery.status === "ssh-error") {
    process.stderr.write(
      `cannot reach ${entry.user ? `${entry.user}@` : ""}${entry.host} over ssh: ${discovery.message}\n` +
      "The machine was not saved. Check plain ssh access, or pass --no-verify.\n",
    );
    return false;
  }
  const { command, args } = sshInvocation(
    endpoint,
    shepherdCommand(discovery.path, entry.remoteSession ?? null, ["server", "start"]),
    { manage, control: "shared", batch: !process.stdin.isTTY, tty: "disable" },
  );
  const started = await runProcess(command, args, 60_000);
  if (started.exitCode !== 0) {
    process.stderr.write(
      `the remote Shepherd daemon did not start: ${started.stderr.trim() || `exit ${started.exitCode}`}\n` +
      "The machine was not saved.\n",
    );
    return false;
  }
  rememberExecutable(entry.id, discovery.path);
  return true;
}
