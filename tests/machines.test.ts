import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addMachine,
  findMachine,
  loadMachines,
  machineEnabled,
  machinesPath,
  parseMachineTarget,
  removeMachine,
  saveMachines,
  updateMachine,
  validateMachineLabel,
} from "../src/machines.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  delete process.env.SHEPHERD_CONFIG_HOME;
});

describe("saved machines", () => {
  it("validates SSH targets and labels", () => {
    expect(parseMachineTarget("deploy@example.com")).toEqual({
      user: "deploy",
      host: "example.com",
    });
    expect(() => parseMachineTarget("example.com:22")).toThrow(
      "invalid SSH host",
    );
    expect(() => validateMachineLabel("-bad")).toThrow(
      "machine labels must be",
    );
    expect(validateMachineLabel(" Build machine ")).toBe("Build machine");
  });

  it("adds, addresses, removes, and persists machines", () => {
    useTemporaryConfig();
    const first = addMachine(loadMachines(), "edge", "deploy@example.com", 2222);
    expect(first.machine).toEqual({
      id: "m1",
      label: "edge",
      user: "deploy",
      host: "example.com",
      port: 2222,
    });
    saveMachines(first.file);
    expect(loadMachines()).toEqual(first.file);
    expect(removeMachine(loadMachines(), "edge").file.machines).toEqual([]);
    expect(fs.existsSync(`${machinesPath()}.tmp`)).toBe(false);
  });

  it("takes the port from ssh:// targets and stores a remote session", () => {
    const { machine, file } = addMachine(
      { version: 1, machines: [] },
      "Build machine",
      "ssh://you@server:2200",
      undefined,
      { remoteSession: "agents" },
    );
    expect(machine).toMatchObject({
      label: "Build machine",
      user: "you",
      host: "server",
      port: 2200,
      remoteSession: "agents",
    });
    expect(findMachine(file, "build MACHINE").id).toBe("m1");
    expect(findMachine(file, "m1").label).toBe("Build machine");
    expect(() => addMachine(file, "build machine", "other")).toThrow("already exists");
    expect(() => addMachine(file, "x", "host", undefined, { remoteSession: "../x" }))
      .toThrow("invalid remote session");
  });

  it("renames, disables, and enables machines", () => {
    const { file } = addMachine({ version: 1, machines: [] }, "edge", "edge.example.com");
    expect(machineEnabled(file.machines[0]!)).toBe(true);
    const disabled = updateMachine(file, "edge", { enabled: false });
    expect(disabled.machine.enabled).toBe(false);
    expect(machineEnabled(disabled.machine)).toBe(false);
    const renamed = updateMachine(disabled.file, "m1", { label: "Edge box", enabled: true });
    expect(renamed.machine).toEqual({
      id: "m1",
      label: "Edge box",
      user: null,
      host: "edge.example.com",
      port: 22,
    });
    const second = addMachine(renamed.file, "other", "other.example.com");
    expect(() => updateMachine(second.file, "other", { label: "edge BOX" })).toThrow("already exists");
  });
});

function useTemporaryConfig(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-machines-"));
  directories.push(directory);
  process.env.SHEPHERD_CONFIG_HOME = directory;
  return directory;
}
