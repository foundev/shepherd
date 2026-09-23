import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultLoadedConfig, parseConfig } from "../src/config/model.js";
import { parseSshDestination } from "../src/machines.js";
import { parseRemoteKeybindings, remoteLoadedConfig } from "../src/remote/attach.js";
import {
  bridgeCommand,
  discoveryCommand,
  installInstructions,
  needsAttention,
  parseDiscovery,
  shepherdCommand,
} from "../src/remote/remoteCommand.js";
import {
  controlPath,
  defaultSshIncludes,
  ensurePrivateDirectory,
  generateSshConfig,
  shellQuote,
  sshArguments,
  sshInvocation,
  writeSshConfig,
} from "../src/remote/ssh.js";
import {
  HEALTHY_RESET_MS,
  nextReconnectDelay,
  RECONNECT_INITIAL_MS,
  RECONNECT_MAX_MS,
} from "../src/server/machineBridge.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  delete process.env.SHEPHERD_SSH_RUNTIME_DIR;
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-ssh-test-"));
  directories.push(directory);
  return directory;
}

describe("ssh config generation", () => {
  it("includes the user's configs before Shepherd's keepalive fallbacks", () => {
    const text = generateSshConfig(["/home/me/.ssh/config", "/etc/ssh/ssh_config"]);
    const userInclude = text.indexOf("Include /home/me/.ssh/config");
    const systemInclude = text.indexOf("Include /etc/ssh/ssh_config");
    const fallbacks = text.indexOf("Host *");
    expect(userInclude).toBeGreaterThan(-1);
    expect(systemInclude).toBeGreaterThan(userInclude);
    expect(fallbacks).toBeGreaterThan(systemInclude);
    expect(text).toContain("  ServerAliveInterval 15\n");
    expect(text).toContain("  ServerAliveCountMax 4\n");
    // Connection reuse is passed on the command line, not in the file.
    expect(text).not.toContain("ControlMaster");
    expect(text).not.toContain("ControlPath");
  });

  it("quotes include paths with spaces and skips missing configs", () => {
    expect(generateSshConfig(["/Users/a b/.ssh/config"]))
      .toContain('Include "/Users/a b/.ssh/config"');
    expect(generateSshConfig([])).not.toMatch(/^Include /m);
    const home = temporaryDirectory();
    expect(defaultSshIncludes(home, () => false)).toEqual([]);
    fs.mkdirSync(path.join(home, ".ssh"));
    fs.writeFileSync(path.join(home, ".ssh", "config"), "Host x\n");
    expect(defaultSshIncludes(home, fs.existsSync)[0]).toBe(path.join(home, ".ssh", "config"));
  });

  it("writes the config content-addressed and private", () => {
    const directory = ensurePrivateDirectory(path.join(temporaryDirectory(), "run"));
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    const first = writeSshConfig(directory, "Host *\n");
    expect(writeSshConfig(directory, "Host *\n")).toBe(first);
    expect(fs.readFileSync(first, "utf8")).toBe("Host *\n");
    expect(fs.statSync(first).mode & 0o777).toBe(0o600);
    expect(writeSshConfig(directory, "Host other\n")).not.toBe(first);
  });

  it("builds managed arguments with a control socket and a remote command", () => {
    const args = sshArguments(
      { user: "deploy", host: "example.com", port: 2222 },
      "shepherd server bridge",
      { manage: true, control: "shared", batch: true, tty: "disable" },
      { configFile: "/tmp/run/ssh_config-abc", controlPath: "/tmp/run/%C" },
    );
    expect(args).toEqual([
      "-F",
      "/tmp/run/ssh_config-abc",
      "-o",
      "BatchMode=yes",
      "-o",
      "ControlMaster=auto",
      "-o",
      "ControlPath=/tmp/run/%C",
      "-o",
      "ControlPersist=60",
      "-T",
      "-p",
      "2222",
      "--",
      "deploy@example.com",
      "shepherd server bridge",
    ]);
  });

  it("uses plain ssh when the config is not managed", () => {
    expect(sshArguments(
      { user: null, host: "workbox", port: null },
      "true",
      { manage: false, control: "shared", batch: false },
      { configFile: "/ignored", controlPath: "/ignored/%C" },
    )).toEqual(["--", "workbox", "true"]);
  });

  it("puts shared and private control sockets in the runtime directory", () => {
    if (process.platform === "win32") return;
    expect(controlPath("/tmp/run", "shared")).toBe("/tmp/run/%C");
    expect(controlPath("/tmp/run", "private")).toBe(`/tmp/run/a${process.pid}-%C`);
    expect(controlPath("/tmp/run", "none")).toBeNull();
  });

  it("resolves an invocation with SHEPHERD_SSH_RUNTIME_DIR", () => {
    const runtime = path.join(temporaryDirectory(), "rt");
    process.env.SHEPHERD_SSH_RUNTIME_DIR = runtime;
    const invocation = sshInvocation(
      { user: null, host: "workbox", port: null },
      null,
      { manage: true, control: "private", batch: true },
    );
    expect(invocation.paths.configFile?.startsWith(runtime)).toBe(true);
    expect(fs.readFileSync(invocation.paths.configFile ?? "", "utf8")).toContain("ServerAliveInterval");
    expect(invocation.args).toContain("-F");
    expect(invocation.args.slice(-2)).toEqual(["--", "workbox"]);
  });
});

describe("ssh destinations", () => {
  it("parses host aliases, user@host and ssh:// URLs", () => {
    expect(parseSshDestination("workbox")).toEqual({ user: null, host: "workbox", port: null });
    expect(parseSshDestination("you@server.example.com"))
      .toEqual({ user: "you", host: "server.example.com", port: null });
    expect(parseSshDestination("ssh://you@server:2222"))
      .toEqual({ user: "you", host: "server", port: 2222 });
    expect(parseSshDestination("ssh://[::1]:2200")).toEqual({ user: null, host: "::1", port: 2200 });
    expect(parseSshDestination("my_box")).toEqual({ user: null, host: "my_box", port: null });
  });

  it("rejects option-like and shell-like targets", () => {
    expect(() => parseSshDestination("-oProxyCommand=x")).toThrow("invalid SSH host");
    expect(() => parseSshDestination("host;rm")).toThrow("invalid SSH host");
    expect(() => parseSshDestination("ssh://host:99999")).toThrow("invalid SSH port");
  });
});

describe("remote commands", () => {
  it("quotes remote command words", () => {
    expect(shellQuote("plain-word")).toBe("plain-word");
    expect(shellQuote("it's here")).toBe(`'it'\\''s here'`);
    expect(bridgeCommand("/home/me/.local/bin/shepherd", null))
      .toBe("/home/me/.local/bin/shepherd server bridge --idle-timeout 60000");
    expect(bridgeCommand("/opt/My Tools/shepherd", "agents", 5_000))
      .toBe("'/opt/My Tools/shepherd' --session agents server bridge --idle-timeout 5000");
    expect(shepherdCommand("shepherd", "default", ["pane", "list"])).toBe("shepherd pane list");
    expect(discoveryCommand()).toMatch(/^sh -c '.*command -v shepherd/);
  });

  it("classifies discovery output and ssh failures", () => {
    expect(parseDiscovery("SHEPHERD_PATH=/usr/local/bin/shepherd\n", "", 0))
      .toEqual({ status: "found", path: "/usr/local/bin/shepherd" });
    expect(parseDiscovery("motd\nSHEPHERD_MISSING\n", "", 0)).toEqual({ status: "missing" });
    expect(parseDiscovery("", "deploy@host: Permission denied (publickey).\n", 255))
      .toEqual({
        status: "ssh-error",
        message: "deploy@host: Permission denied (publickey).",
        attention: true,
      });
    expect(parseDiscovery("", "ssh: connect to host h port 22: Connection refused\n", 255))
      .toMatchObject({ status: "ssh-error", attention: false });
    expect(needsAttention("Host key verification failed.")).toBe(true);
  });

  it("explains how to install instead of copying binaries", () => {
    const text = installInstructions({ user: "you", host: "workbox", port: 2222 });
    expect(text).toContain("shepherd was not found on you@workbox");
    expect(text).toContain("ssh -p 2222 you@workbox");
    expect(text).toContain("npm link");
    expect(text).toContain("does not copy");
  });
});

describe("remote keybindings", () => {
  it("keeps local keys without custom commands, or takes the server's", () => {
    const local = defaultLoadedConfig();
    local.config = parseConfig({
      keys: {
        prefix: "ctrl+a",
        command: [{ key: "prefix+g", command: "lazygit", type: "popup" }],
      },
    });
    const kept = remoteLoadedConfig(local, "local", null);
    expect(kept.config.keys.prefix).toBe("ctrl+a");
    expect(kept.config.keys.commands).toEqual([]);
    expect(kept.keymap.commandsPrefixed.size).toBe(0);

    const server = remoteLoadedConfig(local, "server", {
      prefix: "ctrl+s",
      bindings: {},
      navigate: local.config.keys.navigate,
      commands: [{
        key: "prefix+t",
        type: "popup",
        command: "htop",
        description: "",
        width: "80%",
        height: "80%",
      }],
    });
    expect(server.config.keys.prefix).toBe("ctrl+s");
    expect(server.config.keys.commands).toHaveLength(1);
    expect(server.keymap.prefix).not.toBe(kept.keymap.prefix);
    // The local theme and UI settings stay local.
    expect(server.config.ui).toEqual(local.config.ui);

    expect(parseRemoteKeybindings(undefined)).toBe("local");
    expect(parseRemoteKeybindings("server")).toBe("server");
    expect(() => parseRemoteKeybindings("both")).toThrow("local or server");
  });
});

describe("machine reconnect backoff", () => {
  it("doubles up to two minutes and resets only after a healthy minute", () => {
    let delay = nextReconnectDelay(0, 0);
    expect(delay).toBe(RECONNECT_INITIAL_MS);
    const seen = [delay];
    for (let index = 0; index < 12; index += 1) {
      delay = nextReconnectDelay(delay, 5_000);
      seen.push(delay);
    }
    expect(seen.slice(0, 4)).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(Math.max(...seen)).toBe(RECONNECT_MAX_MS);
    // A brief successful connection does not reset the delay...
    expect(nextReconnectDelay(RECONNECT_MAX_MS, HEALTHY_RESET_MS - 1)).toBe(RECONNECT_MAX_MS);
    // ...a connection that stayed up for a minute does.
    expect(nextReconnectDelay(RECONNECT_MAX_MS, HEALTHY_RESET_MS)).toBe(RECONNECT_INITIAL_MS);
  });
});
