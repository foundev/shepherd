# Product direction

Shepherd is a terminal workspace for people running many coding agents and
the commands around them. A user should be able to start in one directory,
understand what is running, notice what needs attention, and return to the same
work after detaching or reconnecting.

Herdr is an acknowledged inspiration for the workflow. Shepherd's interfaces,
automation contract, and visual language should evolve around its own React
and Ink architecture. Feature coverage is judged by useful user workflows.

## Product bar

- Keep real PTY panes, persistent sessions, workspaces, tabs, mouse and keyboard
  control, agent status, remote access, plugins, and automation as core features.
- Make the interface a reason to choose Shepherd. It should feel composed and
  memorable at first glance, with a deliberate visual system across the main
  view, menus, settings, notifications, and narrow terminals. Status must
  remain readable without color, the focused pane must be obvious, and common
  actions must be discoverable in the UI.
- Ship a feature only when its CLI or API path, UI behavior, error handling,
  and documentation agree. Record unsupported paths explicitly.
- Prefer a cohesive Shepherd interface over copying another product's layout,
  command wording, or palette. Preserve familiar terminal conventions where
  they help users move between tools.

## Use Ink as an advantage

Ink is a React renderer. The UI should use capabilities that come with that
model instead of limiting itself to a frame-by-frame widget port:

- Build reusable stateful components for the workspace header, agent cards,
  command menus, notifications, and settings. Share state through React
  context and focused hooks instead of a mutable module-wide theme.
- Use Ink's Yoga-backed Flexbox for chrome, cards, and responsive overlays.
  Keep explicit cell geometry only where PTY sizing, split borders, and mouse
  hit testing require it.
- Use component focus management for UI-owned controls and preserve direct
  keyboard passthrough while a terminal pane owns focus.
- Treat drag and drop as a reusable React interaction: a visible dragged card,
  clear valid and invalid targets, release and Escape handling, and a keyboard
  path for every move. Terminal apps must still receive their own mouse events
  when they request them.
- Show asynchronous work as local component states: connection progress,
  loading, success, and recoverable errors. Use React's composition and
  Suspense where it improves those flows.
- Memoize live pane surfaces and update only the parts of the component tree
  that changed. Motion should communicate activity or transitions without
  increasing idle CPU use or harming terminal readability.

These are native strengths of the React and Ink architecture; they are not
claims that another TUI toolkit could never reproduce the same behavior.

## Current baseline

| Area | Present | Work to finish |
| --- | --- | --- |
| Terminal workspaces | PTY panes, splits, resize, zoom, swap, copy mode, scrollback | Validate graphics handling and small-terminal behavior |
| Persistence | Detached daemon, snapshots, pane history, agent resume, experimental live handoff | Document failure and recovery paths in the UI |
| Agent awareness | Status evidence, expiring integration reports, explicit uncertainty, lifecycle hooks, notifications | Configurable detection rules, direct attach, real-agent detection accuracy measurements |
| Agent desk | Attention queue across machines, stable selection, bounded card viewport, live output and checkout changes, persistent task context, independent review and checks | Sustained real workloads across dozens of agents |
| Remote work | SSH attach, saved machines, reconnecting bridges, remote pane browsing | Decide whether remote panes can share local layouts |
| Extensibility | Executable plugins, marketplace search, socket API, CLI | Close unsupported API and pane input operations |
| Interface | Sidebar, status list, settings, mouse menus, phone-width view, dark and light themes | Improve first-run guidance, visual hierarchy, and keyboard discoverability |

## Next milestones

The Agent desk is Shepherd's own supervision workflow. Its usefulness is judged
with many agents: can someone find the oldest blocker, understand its task,
inspect its evidence, act, and return to the queue without losing their place?
Task context and review requests persist independently of terminal visibility.
Screen silence is uncertainty; a response ending is an invitation to review.
The preview script and 50-agent interaction tests exercise this design with
simulated workloads. They do not establish real-agent detection accuracy or
long-duration terminal performance.

1. **Visual and usability redesign.** Create a full-screen visual reference for
   the workspace, attention states, overlays, and narrow mode. Review real
   renders at narrow, standard, and wide terminal sizes in dark and light
   Shepherd themes. Refine spacing, typography, borders, interaction feedback, and
   density together. Make the active pane, blocked agent, current workspace,
   and reconnecting machine immediately distinguishable. Add a first-run guide
   to the UI and test the main mouse and keyboard flows with a new user.
2. **Core control parity.** Implement or explicitly retire direct agent attach,
   pane input routing, and configurable detection rules. Keep the CLI and socket
   API aligned, with integration tests for the resulting behavior.
3. **Terminal fidelity.** Audit full-screen TUIs, Unicode, selection, resize,
   mouse forwarding, clipboard, and graphics protocols against real programs.
   Fix failures that prevent ordinary agent workflows.
4. **Release quality.** Exercise detach, restart restore, handoff, SSH
   reconnects, plugin installs, and damaged state recovery across supported
   platforms. Publish a short, tested quick start and a feature status page.

The first release should have no major gaps in everyday local and remote agent
workflows. Add extra features only when they make those workflows simpler or
more reliable.
