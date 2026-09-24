# Checkpoint — 2026-09-23

Shepherd is for supervising many coding agents. Herdr remains credited as an
inspiration in the README; Shepherd's design and implementation evolve independently.

## Ready to use

- `Ctrl+B d` opens the Agent desk: attention queue, cross-workspace search,
  stable selection, local and remote task context, live output, checkout
  changes, and a bounded viewport for large agent lists.
- Task objectives, progress, blockers, next actions, check results, and review
  requests persist. Looking at a terminal does not acknowledge its task review.
- Status includes evidence and confidence. Unrecognized screens stay unknown;
  integration reports expire. Ordinary completion prose does not imply idle.
- Command-backed agent/task panes remain available after exit for inspection.
  Interactive shell panes close when their shell exits. Completed commands are
  not automatically rerun on restoration.
- The CLI and typed API support task reporting, check summaries, review,
  changed-file inspection, expiring status reports, and guarded prompt delivery.
- Claude integration version 3 captures prompt and lifecycle context. Existing
  installations need `shepherd integration install claude` and a Claude restart.
- README shortcuts now match the default bindings. The earlier alternate API
  and compatibility implementation were removed in favor of Shepherd's typed API.

## Verification

- `npm run typecheck` passed.
- `npm run build` passed.
- `npx vitest run`: 52 files, 301 tests passed.
- Rendered the simulated 50-agent desk at 120×30, 60×24, and 40×16.
- Tests cover selection stability, task editing, input isolation, status
  uncertainty and leases, hook lifecycle, review persistence, process exits,
  restore behavior, and checkout changes.

## Next session

1. Exercise sustained workloads with real agents across several projects and
   SSH machines. Simulated 50-agent tests do not establish detection accuracy
   or long-duration performance with 50 real agent processes.
2. Refine the visual design using those populated sessions, including mouse
   interactions and the smaller layouts.
3. Expand direct lifecycle integrations beyond Claude. Other agents currently
   use screen/process detection or the generic reporting CLI/API.

Upgrade saved remote machines for the new task and guarded prompt APIs.
Screen inference can still be wrong; the desk exposes its evidence. Check
results are explicitly reported, and changed files belong to the checkout,
which may be shared by several agents. Session history across daemon restarts
still depends on `experimental.pane_history`.
