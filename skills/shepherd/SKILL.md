---
name: shepherd
description: "Control a Shepherd terminal session when the user explicitly asks to inspect or operate Shepherd panes, tabs, workspaces, agents, or remote machines. Requires SHEPHERD_ENV=1."
---

# Shepherd

Shepherd keeps terminal panes alive in a daemon while its Ink interface attaches and detaches. Use this skill only for an explicit Shepherd task.

Before controlling a session, verify that the current process is in a Shepherd pane:

```bash
test "${SHEPHERD_ENV:-}" = 1
```

If this fails, explain that you are outside a Shepherd-managed pane and stop. Never infer the active session from another terminal.

## Discover the installed commands

The installed binary is the authority. Use `shepherd --help`, then the relevant group help such as `shepherd pane --help` or `shepherd agent --help`. Bare `shepherd` attaches the TUI; do not run it for discovery.

Shepherd's CLI prints JSON for most automation commands. Its socket API uses requests with a `type` field, for example:

```bash
shepherd api schema
shepherd api request '{"type":"state.get"}'
```

Read IDs from these responses. They are stable handles such as `p1`, `t1`, and `w1`; do not guess them from display order.

## Work with panes and agents

Inspect the current layout before making a change:

```bash
shepherd workspace list
shepherd tab list
shepherd pane list
shepherd agent list
```

A pane can run any terminal process. To open another pane, use `shepherd pane split --direction right --cwd "$PWD" --no-focus` or `shepherd pane run --cwd "$PWD" --no-focus "just test"`. `--no-focus` keeps the user's focus on the current pane. Use `--direction down` when the layout calls for a vertical split.

Use `shepherd pane read <pane-id> --rows 80 --source recent-unwrapped` to inspect text. `recent-unwrapped` joins soft-wrapped rows; `visible` reads the current viewport. `shepherd pane write <pane-id> <text>` submits text with Enter. For raw input or a request without a dedicated command, use `shepherd api request` with the request type shown by `shepherd api schema`.

For a recognized coding agent, use `shepherd agent get <target>`, `shepherd agent read <target>`, `shepherd agent wait <target> --status idle`, and `shepherd agent prompt <target> <text>`. A target can be a pane ID or an unambiguous agent kind. Inspect an agent's output when a wait times out or reports a blocked state; do not blindly repeat a prompt.

Shepherd injects `SHEPHERD_PANE_ID` into a managed pane. When working on behalf of the caller, use that ID to identify the source pane and verify the destination from the result of a create command.

## Other useful commands

- `shepherd worktree list <repository>` and `shepherd worktree create <repository> <path> <branch>` manage Git worktrees.
- `shepherd events listen` streams daemon events; `shepherd events wait <event>` waits for one.
- `shepherd machine list` discovers saved SSH machines. `shepherd machine exec <label> -- <command>` runs a Shepherd command on one. `machine run` executes a shell command over SSH.
- `shepherd config template` prints an annotated configuration file.

Do not close panes, tabs, workspaces, or sessions you did not create unless the user asked. Do not stop the daemon from an active session unless the user intends to end its pane processes. Use a separate named session for experiments.
