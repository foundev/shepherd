import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClientConnection } from "../src/client/connection.js";
import { ShepherdDaemon } from "../src/server/daemon.js";
import { connect } from "../src/transport.js";
import type { EventFrame } from "../src/types.js";

describe("Shepherd runtime events", () => {
  let stateRoot: string;
  let socketPath: string;
  let daemon: ShepherdDaemon;
  let subscriber: ClientConnection;
  let resolveReceived!: (frame: EventFrame) => void;
  let received!: Promise<EventFrame>;
  let agentEvents: EventFrame[] = [];
  let resolveAgentEvent!: (frame: EventFrame) => void;

  beforeAll(async () => {
    stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-events-"));
    socketPath = path.join(stateRoot, "daemon.sock");
    process.env.SHEPHERD_STATE_HOME = stateRoot;
    daemon = new ShepherdDaemon({ session: "events", socketPath });
    await daemon.start();
    received = new Promise((resolve) => {
      resolveReceived = resolve;
    });
    subscriber = ClientConnection.open(await connect(socketPath), (frame) => {
      if (frame.event === "state.changed") resolveReceived(frame);
      if (frame.event === "agent.status.changed") {
        agentEvents.push(frame);
        if (frame.data.status === "blocked") resolveAgentEvent(frame);
      }
    });
  });

  afterAll(async () => {
    subscriber.close();
    await daemon.stop();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  it("pushes state changes to subscribed clients", async () => {
    await subscriber.request({ type: "events.subscribe" });

    const controlSocket = await connect(socketPath);
    const control = ClientConnection.open(controlSocket);
    try {
      await control.request({ type: "tab.create", name: "events" });
    } finally {
      control.close();
    }

    const event = await received;
    expect(event.event).toBe("state.changed");
    expect(typeof event.data.stateVersion).toBe("number");
  });

  it("resolves event wait requests without a subscription", async () => {
    const controlSocket = await connect(socketPath);
    const control = ClientConnection.open(controlSocket);
    try {
      const waiting = control.request({
        type: "events.wait",
        event: "state.changed",
        timeoutMs: 3_000,
      }, 4_000);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await subscriber.request({ type: "tab.create", name: "waiter" });
      const event = await waiting as EventFrame;
      expect(event.event).toBe("state.changed");
    } finally {
      control.close();
    }
  });

  it("emits agent lifecycle transitions", { timeout: 15_000 }, async () => {
    agentEvents = [];
    const blocked = new Promise<EventFrame>((resolve) => {
      resolveAgentEvent = resolve;
    });
      await subscriber.request({
        type: "pane.create",
        direction: "right",
        command:
          "claude --version >/dev/null; printf 'Do you want to continue? [y/N]'; sleep 8",
        title: "claude",
      });
      const event = await blocked;
      expect(event.data.status).toBe("blocked");
      expect(event.data.agent).toBe("claude");
      expect(agentEvents.length).toBeGreaterThan(0);
  });
});
