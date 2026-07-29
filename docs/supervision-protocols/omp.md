Mode: OMP hub process supervision.

When this session owns supervision and away mode is not active:
1. Drain first with `bin/fm-wake-drain.sh`.
2. Use OMP's `hub` tool, not shell backgrounding, for every watcher cycle.
   Start one project-scoped supervised process named for this home, running `bash -lc '[ -f __FM_X_MODE_ENV_SH__ ] && . __FM_X_MODE_ENV_SH__; exec bin/fm-watch-arm.sh --restart'` from the firstmate root.
   Use a readiness condition that matches `watcher: started` or `watcher: attached`.
3. After the `start` call reports ready, immediately call `hub` `wait` for that same process name with a bounded timeout.
   OMP process waits are capped, so a timeout with the process still running is not a wake; call `wait` again while supervision is still required.
4. When the `wait` call returns because the process exited, run `bin/fm-wake-drain.sh` first, then handle the queued wake.
   If the drain output is empty or ambiguous, inspect the supervised process log with `hub` `logs` before choosing a repair action.
5. Ordinary work, turn completion, and ordinary signal, stale, check, heartbeat, or other wake handling: after the wake is handled, start exactly one successor `hub` process cycle and wait on it again while supervision is still required.
6. Missing, failed, or unhealthy cycle only: inspect the failure, stop any stuck process with `hub` `stop` if OMP still lists it, then start one replacement process and wait on it.
7. Never use shell `&` for watcher supervision.
   The OMP hub process survives the tool call, keeps the process attached to the project-scoped broker, and wakes the model when `hub` `wait` returns on process exit.

OMP does not use Claude's Stop `asyncRewake` auto-arm contract.
It has a `session_stop` extension continuation hook, which the tracked turn-end guard extension uses as a backstop when a turn would otherwise end blind, but routine watcher arm and re-arm remain explicit OMP hub process operations.

The turn-end guard extension lives at `__FM_PI_TURNEND_EXT__`.
The watcher extension lives at `__FM_PI_EXT__` and is loaded only for the shared load marker and session lifecycle; it registers no watcher tool on OMP, so `hub` is the single owner of the cycle.
Both files are exposed to OMP through tracked delegating entry files in `.omp/extensions`, which are the only extensions OMP discovers from this repo.
Those entry files are also how the shared code knows it is on OMP: they pass the runtime in, because OMP sets `OMPCODE` only in the shells it spawns for tool calls, never in its own extension host.
