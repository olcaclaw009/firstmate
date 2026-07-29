# Calm mode

Calm is a Pi-family and OMP conversation presentation toggle.
It is off by default, and the last `/calm` choice persists for the effective Firstmate home across Pi-family and OMP session starts and resumes.

While Calm is active, Pi's built-in `Working...` activity remains visible and no separate Calm status row is added.
OMP lacks Pi's `setWorkingVisible` and `setHiddenThinkingLabel` UI methods, so those two presentation controls log a one-time diagnostic and are otherwise left to OMP.
Calm hides collapsed thinking labels, the shells for Pi's seven built-in tools, OMP's active `BUILTIN_TOOLS` registry, the `fm_watch_arm_pi` tool shell, and canonically classified Firstmate operational user rows.
The operational inputs remain ordinary user-role messages, while Pi's transcript layout renders their complete rows at zero height.
The session-start nudge remains on its existing non-displayed custom-message path.

Calm changes presentation only.
Tool execution, input delivery, ordering, model context, session storage, diagnostics, and `/export` and `/share` operation remain unchanged.
Every hidden Firstmate input remains available to the model and in serialized session data and exported artifacts.
Legacy operational custom messages remain in session data and Pi's sidebar tree, although the main HTML transcript may omit them.
Toggling Calm off restores ordinary rendering, and `Ctrl+O` expansion state is preserved.

The supported presentation APIs do not expose a global transcript filter.
Expanded reasoning and its reserved spacing, built-in tool images, user-bash rows, skill and summary rows, generic status notices, and arbitrary custom-tool or extension rows remain visible unless covered by the runtime-specific adapters above.
These are supported-API boundaries rather than hidden-content failures.

## Runtime compatibility

Calm has no numeric Pi or OMP version minimum or maximum and never refuses a supported runtime solely because its version is newer than a previously verified version.
The collapsed-thinking and operational-user-row presentation adapters probe the exact API seam they patch when Calm loads.
If a runtime removes one of those seams, Calm logs a diagnostic naming the unavailable adapter and skips only that adapter; `/calm`, the other adapter, and unrelated extensions remain available.
OMP tool-row coverage composes `BUILTIN_TOOLS` definitions with standalone tool renderers or OMP's generic shell renderer, and refuses to load if it cannot account for the registry.

[`calm-mode-feasibility.md`](calm-mode-feasibility.md) owns the version-scoped renderer taxonomy and empirical evidence.
[`configuration.md`](configuration.md#pi-calm-preference-configcalm) owns the persisted preference file and resolution rules.
`.pi/extensions/lib/fm-calm-visibility.ts` owns the visibility policy, `.pi/extensions/lib/fm-calm-operational-user-layout.ts` owns the zero-height operational-user row adapter, and `.pi/extensions/lib/fm-calm-omp-layout.ts` owns the OMP assistant layout adapter.

Regression entry points:

```sh
tests/fm-calm-pi-extension.test.sh
tests/fm-omp-primary.test.sh
tests/fm-pi-primary-types.test.sh
FM_PI_LIVE_E2E=1 tests/fm-pi-primary-live-e2e.test.sh
```
