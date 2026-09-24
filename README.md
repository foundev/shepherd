# Shepherd

Shepherd is a terminal workspace for supervising many coding agents across
projects and machines, built with **Node.js + React + Ink**.

The goal is a polished agent runtime with a simple core model:

```text
attached React TUI → local daemon → real PTY panes
```

Detach the client and the daemon keeps every terminal process alive. Split panes,
launch coding agents, inspect their status, and automate them over JSON.

Shepherd was inspired by [Herdr](https://github.com/herdrdev/herdr), especially
its focus on persistent terminal workspaces for coding agents. Thanks to the
Herdr project for showing how useful that workflow can be. Shepherd has its own
React and Ink interface, CLI, typed socket protocol, themes, and interaction
model.

## Current state

Shepherd is a working but still evolving multiplexer. The runtime and automation
surface are substantial; the interface and onboarding are the current focus.

Implemented:

- persistent detached daemon
- Unix socket / Windows named-pipe transport
- newline-delimited JSON protocol
- real PTY ownership through `node-pty`
- terminal parsing and screen retention through `@xterm/headless`
- true-color and styled terminal rendering in Ink
- workspaces
- tabs
- horizontal and vertical pane splits
- pane zoom
- pane swap and pane move
- split-ratio resizing
- local executable plugins with an action picker
- GitHub `shepherd-plugin` marketplace search and background catalog refresh
- focus and keyboard input routing
- SGR mouse focus, workspace/tab clicks, and wheel scrolling
- mouse dragging of split borders
- mouse dragging to swap panes
- drag previews for pane swaps and tab or workspace moves
- shift-drag terminal selection and clipboard copy
- pane resize and screen snapshots
- visible, recent, and soft-wrap-aware scrollback reads
- pane, tab, and workspace renaming
- tab layout export and safe reapplication
- pane create/read/write/close automation API
- state snapshots for layout restoration
- experimental live daemon handoff that preserves running pane processes
- named daemon sessions with list, attach, and delete commands
- Git worktree list/create/open/remove automation
- agent detection for 23 agents, with reported or inferred status evidence and explicit uncertainty
- a sidebar agent panel grouped by space or by attention status, with persistent task context
- persistent task summaries, blockers, next actions, check results, and explicit review acknowledgement
- Claude lifecycle hooks that capture prompts, permission requests, and response summaries
- agent get/read/wait/prompt automation
- runtime event subscriptions and event waits
- agent status-change events with blocked/done terminal notifications
- simultaneous attached clients with independent workspace, tab, and pane focus
- `shepherd --remote <ssh-target>`: the local UI attached to a daemon on another machine over SSH
- saved SSH machines with one persistent, health-checked, auto-reconnecting bridge each, shown in a machines sidebar with their workspaces
- saved-machine commands and a remote Shepherd command runner
- streaming remote pane surface reads and input from the local UI
- tiled streaming dashboard for every reachable remote pane
- typed socket API
- versioned API schema and raw request CLI
- adaptive terminal UI with a sidebar, agent status list, and phone-width layout
- nine Shepherd themes, with distinct status symbols by default

Open work:

- remote panes embedded directly inside local workspace layouts
- direct agent attachment and pane input routing commands
- configurable agent detection manifests
- graphics transport for terminal applications that use image protocols
- more automation commands for specialized workflows

## Design direction

Shepherd's default theme uses deep navy surfaces, a sea-glass accent, and
separate colors and symbols for agent states. A matching light theme is
available in settings.

Built-in themes are `shepherd`, `shepherd-day`, `aurora`, `ember`, `midnight`,
`orchid`, `glacier`, `parchment`, and `terminal`. Each supports custom color
overrides. Use `shepherd config template` for an annotated configuration file.

The visual goal is a distinctive, polished terminal dashboard. The active
pane, agents needing attention, and the current local or remote workspace
should stand out at a glance. Mouse and keyboard flows should expose the same
core actions.

Ink's React renderer is a central part of that direction: reusable stateful
components, hooks for live activity, component-owned loading and error states,
and Flexbox layout for UI chrome. PTY panes still use exact cell geometry so
terminal programs receive the correct dimensions.

See [product direction](docs/PRODUCT_DIRECTION.md) for the feature and usability
work needed before a stable release.

The UI is implemented with [Ink](https://github.com/vadimdemedes/ink), so panes,
sidebar rows, tab strips, and status controls are ordinary React components.

## Install

```bash
npm install
npm run build
./bin/shepherd
```

Node 22 or newer is required.

If your npm security policy blocks native package scripts, approve and rebuild
the PTY dependency:

```bash
npm install-scripts approve node-pty@1.0.0
npm rebuild node-pty
```

## Run

The default command starts or connects to the daemon and attaches the UI:

```bash
./bin/shepherd
```

Detach with:

```text
Ctrl+B, then q
```

PTY processes continue running in the daemon.

### Keyboard

```text
Ctrl+B c      new tab
Ctrl+B T      rename tab
Ctrl+B N      new workspace
Ctrl+B W      rename workspace
Ctrl+B w      workspace picker
Ctrl+B g      search workspaces and panes
Ctrl+B d      toggle agent grouping (spaces/status)
Ctrl+B [      copy mode
Ctrl+B v      split right
Ctrl+B -      split down
Ctrl+B z      zoom focused pane
Ctrl+B r      resize mode
Ctrl+B P      rename focused pane
Ctrl+B a      plugin action picker
Ctrl+B p/n    previous/next tab
Ctrl+B M      refresh saved machine summaries
Ctrl+B B      tiled streaming remote pane dashboard
Ctrl+B E      remote pane surface browser
Ctrl+B A      remote agent reader and prompter
Ctrl+B Tab    focus next pane
Ctrl+B o      open notification target
Ctrl+B x      close focused pane
Ctrl+B 1..9   select tab
Ctrl+B q      detach client
Ctrl+B ?      shortcut reminder
```

In terminal mode, unbound keys—including Ctrl+C—are forwarded to the focused PTY.

## Supervising agents

Toggle the sidebar agent panel between workspaces (`spaces`) and attention
status (`status`) with `Ctrl+B d`, the global menu, or a click on the agent
summary or the grouping label. The status view groups agents under
NEEDS YOU, REVIEW, CHECK STATUS, WORKING, and READY headers, covering
blockers, failed checks, pending reviews, and uncertain status. Oldest
attention comes first within each group.
Scroll the panel or click its previous/next controls to reach overflow agents.
An explicit `agent.view.set` sort takes precedence over status grouping.

Task context is saved immediately and survives reconnects and daemon restarts.
Viewing a terminal does **not** acknowledge its task review. Reported checks
are separate from review: acknowledging a result never implies tests passed.
Changed files describe the pane's current checkout, which may be shared with
other agents (`shepherd task changes` shows up to 200 files and reports the total).

```bash
shepherd task update p2 --title "Fix retry handling"
shepherd task update p2 --summary "Added backoff and cancellation" \
  --next "Review the cancellation path" --checks passed \
  --check-summary "npm test: 42 passed" --review requested
shepherd task get p2
shepherd task changes p2
shepherd agent send p2 "Investigate the failing integration test"
```

Changing a task title clears its previous result, checks, and review unless
the same update explicitly supplies replacements. `--if-revision NUMBER`
protects automation from overwriting newer edits. Concurrent edits in the UI
are rejected with a message to reopen the task.

### Status you can inspect

Status distinguishes integration reports, screen inference, and unknown
status. Unmatched screens and ordinary prose containing “finished” do not
prove an agent is idle. Integration reports have a two-minute lease by
default; newer visible activity can supersede an older report. The API retains
`done` for compatibility; the UI calls this **review**, meaning an observed
return to idle, not a verified successful outcome.

Install or upgrade the Claude integration:

```bash
shepherd integration install claude
```

Version 3 uses Claude's [documented lifecycle hooks](https://code.claude.com/docs/en/hooks)
to record the submitted task, refresh activity, surface permission requests,
and capture response summaries for review. It ignores subagent events and
does not approve permissions or infer test results. Reinstall older hooks and
restart Claude to load the updated configuration. Prompts and summaries are
stored as task context in Shepherd's session state and rolling snapshots.

Other integrations can report through the CLI or typed socket API:

```bash
shepherd agent report p2 working --agent codex --source my-hook --ttl 120000
shepherd task update p2 --summary "Tracing the failure" --source my-hook
```

Refresh reports before their lease expires. Sending an instruction through
`agent send` or `agent prompt` requires a recognized idle agent; inspect and
respond to blocked or uncertain agents in their terminals. Prompt waits keep
their timeout result when no activity is observed. Upgrade saved remote
machines to this version for task editing and guarded prompt delivery.

### Returning to work

Detaching preserves the running processes. A daemon restart can recreate
commands or request an agent session resume; resumed panes are marked so
they can be verified. Exited command-backed agent/task panes retain their
output for review until explicitly closed; interactive shell panes close when
their shell exits. Completed commands are not rerun on restoration; their task
context is restored beside a new shell. Terminal history across daemon
restarts still requires `experimental.pane_history`.

## Automation API

```bash
shepherd server status
shepherd api schema
shepherd api schema --json
shepherd api request '{"type":"ping"}'
shepherd session list
shepherd session attach research
shepherd session delete research --yes
shepherd workspace list
shepherd workspace new --name research
shepherd workspace use w1
shepherd workspace rename w1 production
shepherd tab list
shepherd tab rename t1 review
shepherd pane list
shepherd pane rename p1 agent-host
shepherd pane zoom p1
shepherd pane swap p1 p2
shepherd pane move p1 t2
shepherd pane resize-layout p1 --delta 0.05
shepherd pane run --no-focus "codex"
shepherd pane focus p2
shepherd pane read p2 --rows 80 --source recent-unwrapped
shepherd pane write p2 "explain this repository"
shepherd pane type p2 "text without Enter"
shepherd pane wait-output p2 "ready" --timeout 30000
shepherd pane close p2
shepherd layout export t1
shepherd layout apply t1 layout.json
shepherd worktree list /path/to/repository
shepherd worktree create /path/to/repository /path/to/worktree feature
shepherd worktree open /path/to/worktree
shepherd worktree remove /path/to/repository /path/to/worktree
shepherd agent list
shepherd agent manifests
shepherd agent explain <pane-or-agent>
shepherd agent get claude
shepherd agent read claude --rows 80 --source recent-unwrapped
shepherd agent wait claude --status idle
shepherd agent prompt claude "summarize the failing test"
shepherd events wait state.changed
shepherd events listen
shepherd plugin link ./my-plugin
shepherd plugin search
shepherd plugin search "layout tools" --limit 10
shepherd plugin marketplace list
shepherd plugin marketplace refresh
shepherd plugin preview example/example-tools
shepherd plugin list
shepherd plugin invoke example.tools status
shepherd server stop
```

Commands return human-readable output where useful and JSON for automation
state. The wire protocol is newline-delimited JSON, making it straightforward
to bind future agent SDKs, HTTP bridges, or remote clients.

Socket requests use `{"id":"1","type":"pane.get","paneId":"p1"}` and replies
use `{"id":"1","ok":true,"result":...}` or `{"id":"1","ok":false,"error":...}`.
`shepherd api schema --json` lists the supported request types and parameters.

Earlier experimental snapshots used a second `{id, method, params}` API and
alternate command forms. Those have been removed. Update scripts to the typed
API and the commands shown by `--help`; use `machine exec LABEL -- COMMAND`
for remote Shepherd commands. The old theme names have also been replaced by
the themes listed above. Previously installed Claude hooks are marked outdated
by `shepherd integration list`; reinstall them with
`shepherd integration install claude` to use the new protocol.

The event channel currently emits `state.changed` after topology, focus, name,
zoom, and plugin registry changes, `plugin.invoked` after plugin actions
finish, and `agent.status.changed` after recognized agent lifecycle
transitions. Subscribed clients receive event frames on the same socket;
one-shot clients can use `events.wait`. The attached UI rings the terminal bell
and shows a status message when an agent becomes `blocked` or `done`.

## Local plugins

A plugin is a directory containing `shepherd-plugin.toml`. Every command is a
plain argv array, runs with the plugin directory as its working directory, and
never goes through a shell:

```toml
id = "example.tools"
name = "Project tools"
version = "0.1.0"
description = "Project helpers"
min_shepherd_version = "0.1.0"       # refused by older Shepherd builds
platforms = ["linux", "macos"]       # optional; items may override it

[[build]]                            # run by `plugin install` only
command = ["npm", "ci"]

[[startup]]                          # daemon start and after live handoff
command = ["node", "tools/restore.js"]

[[actions]]
id = "status"
title = "Show status"
contexts = ["workspace", "pane"]     # global|workspace|tab|pane|selection
command = ["node", "tools/status.js"]

[[events]]
on = ["tab.created", "pane.agent_status_changed"]
command = ["node", "tools/on-event.js"]

[[panes]]
id = "board"
title = "Project board"
placement = "popup"                  # overlay (default)|popup|split|tab|zoomed
width = "80%"                        # popup only: cells or a percentage
height = 20
command = ["node", "tools/board.js"]

[[link_handlers]]
id = "issue"
title = "Open issue"
pattern = "^https://tracker\\.example\\.com/issues/[0-9]+$"
action = "status"
```

- **Startup hooks** run for each enabled plugin once the daemon's socket is
  ready, including in the daemon that takes over during `server handoff`,
  but not when a plugin is linked or enabled.
- **Event hooks** run when a daemon event fires. `on` takes one name or a list:
  the lifecycle events (`workspace.created`, `workspace.closed`,
  `workspace.focused`, `tab.created`, `tab.closed`,
  `tab.focused`, `pane.created`, `pane.closed`, `pane.focused`, `pane.exited`,
  `pane.agent_detected`, `pane.agent_status_changed`, `layout.updated`, ...)
  and Shepherd's own `pane.bell`, `agent.status.changed`,
  `notification.show`, `popup.opened`, `popup.closed` and
  `marketplace.updated`. Unknown names link with a warning. The event JSON
  (`{"event": ..., "data": ...}`) is passed in `SHEPHERD_PLUGIN_EVENT_JSON` and
  on stdin.
- **Panes** open with `shepherd plugin pane open ID ENTRYPOINT
  [--placement P]`. `split`, `tab` and `zoomed` panes are ordinary panes;
  `overlay` opens a zoomed split and restores the tab's previous focus and zoom
  when it closes; `popup` opens a session-modal popup on the attached UI.
  `plugin pane focus|close <pane_id>` act on panes a plugin opened.
- **Link handlers**: Ctrl-clicking a URL that matches `pattern` (a JavaScript
  regular expression; plugins and handlers are checked in order) runs the
  named action instead of opening the URL. The action receives
  `SHEPHERD_PLUGIN_CLICKED_URL`, `SHEPHERD_PLUGIN_LINK_HANDLER_ID`, and
  `invocation_source = "link_click"` in its context JSON.

Link, invoke and inspect it locally:

```bash
shepherd plugin link ./example-tools
shepherd plugin invoke example.tools status
shepherd plugin logs example.tools --limit 20
shepherd plugin config-dir example.tools
shepherd plugin pane open example.tools board
```

Every action, startup hook, event hook and plugin pane is recorded in an
in-memory log (the last 100 runs per plugin): command, status, exit code,
timestamps and the tail of stdout/stderr. Read it with `plugin logs` or the
typed `plugin.log-list` API request.

Install a plugin from public GitHub shorthand:

```bash
shepherd plugin install example/example-tools
shepherd plugin install example/example-tools --ref <commit-or-tag> --yes
shepherd plugin uninstall example.tools
```

The installer accepts only `owner/repo[/subdir]`, performs a shallow Git fetch,
prints the manifest and a preview of every command it may run (builds, startup
and event hooks, panes, link handlers), requires confirmation in a terminal or
`--yes` noninteractively, runs declared build commands, rejects manifests that
change during those builds, and replaces a previous managed checkout
atomically. Installing over a locally linked plugin is refused. `plugin
uninstall` unregisters an installed plugin and deletes its managed checkout;
locally linked plugins are removed with `plugin unlink`, which leaves their
files alone.

Enabled actions also appear in the `Ctrl+B p` picker. Plugin processes
(actions, hooks and panes) receive:

| Variable | Value |
| --- | --- |
| `SHEPHERD_PLUGIN_ID`, `SHEPHERD_PLUGIN_ROOT` | plugin id and directory |
| `SHEPHERD_PLUGIN_CONFIG_DIR` | per-plugin config directory (`~/.config/shepherd/plugins/<id>`, under `SHEPHERD_CONFIG_HOME` when set) for user settings such as `.env` files |
| `SHEPHERD_PLUGIN_STATE_DIR` | per-plugin, per-session state directory |
| `SHEPHERD_SOCKET_PATH`, `SHEPHERD_BIN_PATH` | daemon socket and Shepherd entry point for calling back |
| `SHEPHERD_ACTIVE_WORKSPACE_ID`, `SHEPHERD_ACTIVE_TAB_ID`, `SHEPHERD_ACTIVE_PANE_ID` | the selection when the command started |
| `SHEPHERD_PLUGIN_CONTEXT_JSON` | full invocation context (ids, labels, cwd, agent, source) |
| `SHEPHERD_PLUGIN_ACTION_ID` | actions |
| `SHEPHERD_PLUGIN_EVENT`, `SHEPHERD_PLUGIN_EVENT_JSON` | startup (`startup`) and event hooks |
| `SHEPHERD_PLUGIN_ENTRYPOINT_ID` | panes |

Shepherd creates the config and state directories but never reads, syncs or
deletes their contents. Do not keep state in the plugin root: installed
plugins are managed checkouts that reinstalling replaces.

Plugins are ordinary executable code and run with the current user's
permissions. Link only manifests and repositories you trust.
The daemon refreshes and caches the marketplace catalog every 30 minutes.
Set `SHEPHERD_MARKETPLACE_REFRESH_MS` to change the interval, or set it to `0`
to disable background refresh.

## Remote attach over SSH

Attach your local UI to the Shepherd daemon on another machine:

```bash
shepherd --remote workbox
shepherd --remote you@server --session agents
shepherd --remote ssh://you@server:2222
shepherd attach --remote workbox --remote-keybindings server
```

The remote daemon owns the panes; the local client draws the UI with your
local theme and settings. Shepherd runs `ssh` to execute a hidden
`shepherd server bridge` command on the remote host, which starts the remote
daemon if needed and pipes the SSH channel to its socket. If the bridge
drops, the client re-spawns ssh with backoff and resumes.

Before connecting, Shepherd checks for `shepherd` on the remote `PATH` (and
common install directories such as `~/.local/bin`). If it is missing,
Shepherd prints install instructions and exits; it never copies binaries to
the remote host. The first connection may prompt for a passphrase or host key
as plain `ssh` would; reconnects never prompt.

Keybindings are local by default. Local custom command keys (`[[keys.command]]`)
are left out, since those commands would run on the remote host.
`--remote-keybindings server` uses the remote daemon's keymap and commands
instead (fetched with the `config.keymap` API request).

By default ssh runs through a generated config that `Include`s your
`~/.ssh/config` (and the system config) first, so your settings win, then adds
`ServerAliveInterval 15` / `ServerAliveCountMax 4` fallbacks. Connections are
reused through a private `ControlMaster` socket in `/tmp/shepherd-ssh-<uid>`.
Turn this off to use plain `ssh`:

```toml
[remote]
manage_ssh_config = false
```

## Saved SSH machines

Save machines to keep them in one Shepherd window:

```bash
shepherd machine add workbox --label "Build machine"
shepherd machine add you@server --label gpu --remote-session agents
shepherd machine list --json
shepherd machine rename m1 --label builder
shepherd machine disable m1
shepherd machine enable m1
shepherd machine remove m1
```

`machine add` checks that Shepherd is installed on the host and starts its
daemon before saving (pass `--no-verify` to skip). The older positional form,
`shepherd machine add edge deploy@example.com --port 2222`, still works and
saves without checking. Records live in `~/.config/shepherd/machines.json`, or
`SHEPHERD_CONFIG_HOME` when set; a running daemon applies changes within a
second.

The daemon keeps one persistent bridge per enabled machine, all sharing one
SSH ControlMaster per host. A bridge opens while a UI is attached (or when a
machine command needs it), subscribes to the remote event stream to keep the
remote workspaces current, sends a health check every 20 seconds, and
reconnects with backoff up to two minutes (a connection must stay healthy for
a minute to earn a fast retry). The remote end closes a bridge after a minute
without traffic, and the daemon closes bridges nothing has used for a minute.
Machine status is one of `online`, `connecting`, `reconnecting`, `attention`
(authentication, host key, or a missing install needs you), `disabled`, or
`idle` (no bridge open because nothing needs it).

With saved machines the sidebar switches to a machines view: a ` machines`
header, a `▾ Local` row with your workspaces, and a row per machine
(`◐` connecting, `●` online, `!` attention, `·` disabled) with its
workspaces nested under it. Workspaces of a machine that is not online are
shown dimmed from the last known state. Click an arrow to collapse a machine;
click a remote workspace to show its panes in the streaming dashboard.

Run commands on a saved machine:

```bash
shepherd machine status gpu
shepherd machine exec gpu -- agent list
shepherd machine exec gpu -- pane read p1 --rows 40
shepherd machine pane-read gpu p1
shepherd machine pane-write gpu p1 "git status --short"
shepherd machine agent-read gpu claude
shepherd machine agent-prompt gpu claude "summarize the failing test"
shepherd machine run gpu "git status --short"
shepherd machine attach gpu
```

`machine exec` runs a command with the machine's Shepherd (and its saved remote
session) over the shared ControlMaster; the resolved remote executable is
cached in `machine-cache.json` next to `machines.json`. The `machine
pane-*`/`agent-*` commands, and the daemon's `machine.*` API requests
(including `machine.request`, which forwards any request), go over the
daemon's persistent bridge instead of a new ssh per call. `machine attach` is
`--remote` for a saved machine. `machine run` runs a shell command over SSH.

`Ctrl+B M` refreshes every machine. `Ctrl+B R` reads a remote agent's recent
output and submits a prompt. `Ctrl+B D` renders every reachable remote pane in
a two-column streaming dashboard, and `Ctrl+B E` focuses one pane, refreshes
it every 750ms, and sends input. Remote panes live in these dedicated
surfaces rather than joining local workspace layouts.

## Architecture

```text
src/client
  App.tsx             React/Ink application shell
  TerminalPane.tsx    styled xterm screen renderer
  Sidebar.tsx         agent deck and pane inventory
  connection.ts       request/response client transport

src/server
  daemon.ts           process registry, tabs, panes, protocol dispatch
  terminal.ts         node-pty + xterm-headless session
  layout.ts           binary split trees and geometry
  persistence.ts      atomic state snapshots
  machineBridge.ts    persistent bridges to saved machines

src/remote
  ssh.ts              generated ssh config, ControlMaster paths, argv
  bridge.ts           `server bridge` pipe and the ssh child stream
  remoteCommand.ts    remote install discovery and command lines
  attach.ts           `--remote` attach

src/protocol.ts       NDJSON encode/decode
src/types.ts          protocol and runtime contracts
src/cli.ts            Commander CLI
```

### Runtime paths

- socket override: `SHEPHERD_SOCKET_PATH`
- state-directory override: `SHEPHERD_STATE_HOME`
- session selection: `--session NAME`

Default Unix socket:

```text
~/.local/state/shepherd/<session>/daemon.sock
```

The Unix socket is chmod `0600` after binding.

## Development

```bash
npm run typecheck
npm test
npm run build
npm run bench-render-scale
npm run dev -- server start --foreground
```

The test suite covers protocol framing, layout split/removal/geometry, agent
recognition, and blocked-state heuristics.

`bench-render-scale` reports layout-model and React/Ink render timing at 1, 15,
and 50 populated panes. It is a manual profile rather than a timing gate.

## Security notes

The daemon is a control plane for processes running as the current user. Any
process that can reach the socket can send input to panes and request pane
creation. Keep the default user-only socket permissions and do not forward it
to another machine. `--remote` and saved machines reach a remote daemon only
through `shepherd server bridge` run over your own SSH login, so access is
exactly your SSH access to that account. Shepherd stores no passwords, keys,
or control sockets in `machines.json`.

State snapshots contain commands and working directories, not terminal
transcripts. Restoring a snapshot recreates layout and launches the saved
commands; original processes cannot survive daemon or machine restart.

## License

Apache-2.0
