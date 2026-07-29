// Firstmate's home-persistent Pi transcript presentation toggle.
//
// Verified against Pi 0.81.1 and 0.82.0, which expose built-in ToolDefinitions, per-slot
// renderers, renderShell: "self", session_start replacement reasons,
// ExtensionUIContext.setToolsExpanded(), setWorkingVisible(), and
// setHiddenThinkingLabel(). The focused tests pin those assumptions but never reject a
// newer Pi solely for its version. The collapsed-thinking and operational-user
// presentation adapters probe the exact API they patch and degrade independently with a
// diagnostic (see installCalmPresentationAdapter below) if a future Pi removes it; Pi
// still exposes no global renderer for arbitrary built-in or custom rows.
// docs/configuration.md owns the home-local Calm preference contract.
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import { Box, Container, getKeybindings, type Component } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import { installCalmAssistantLayout } from "./lib/fm-calm-assistant-layout.ts";
import { installCalmOperationalUserLayout } from "./lib/fm-calm-operational-user-layout.ts";
import { installOmpAssistantLayout } from "./lib/fm-calm-omp-layout.ts";
import {
  calmPresentationHides,
  calmPresentationIsActive,
  FIRSTMATE_CALM_PRESENTATION_EVENT,
  registerFirstmateSyntheticPresentation,
  setCalmPresentation,
  setCalmStockExportRendering,
} from "./lib/fm-calm-visibility.ts";

type DefinitionFactory<TParams extends TSchema, TDetails, TState> = (
  cwd: string,
) => ToolDefinition<TParams, TDetails, TState>;

type RenderContext<TParams extends TSchema, TDetails, TState> = Parameters<
  NonNullable<ToolDefinition<TParams, TDetails, TState>["renderCall"]>
>[2];

type RenderArgs<TParams extends TSchema, TDetails, TState> = Parameters<
  NonNullable<ToolDefinition<TParams, TDetails, TState>["renderCall"]>
>[0];

type RenderTheme<TParams extends TSchema, TDetails, TState> = Parameters<
  NonNullable<ToolDefinition<TParams, TDetails, TState>["renderCall"]>
>[1];

type RenderResult<TParams extends TSchema, TDetails, TState> = Parameters<
  NonNullable<ToolDefinition<TParams, TDetails, TState>["renderResult"]>
>[0];

type StandardShellState = {
  shell?: Box;
  call?: Component;
  result?: Component;
};

type OmpToolSession = {
  cwd: string;
  settings: unknown;
};

type OmpBuiltinFactory = (
  session: OmpToolSession,
) =>
  | ToolDefinition<TSchema, unknown, unknown>
  | Promise<ToolDefinition<TSchema, unknown, unknown> | null>
  | null;

type OmpToolRenderer = {
  mergeCallAndResult?: boolean;
  renderCall: (...args: unknown[]) => Component | undefined;
  renderResult: (...args: unknown[]) => Component | undefined;
};

type OmpCreateShellRenderer = (options: {
  resolveTitle: () => string;
}) => OmpToolRenderer;

const extensionFile = fileURLToPath(import.meta.url);
const extensionDir = dirname(extensionFile);
const root = resolve(extensionDir, "../..");
const piCodingAgent = PiCodingAgent as unknown as Record<string, unknown>;
// OMP sets OMPCODE and also inherits compatibility markers in common nested
// launch paths. The host module shape is the runtime discriminator: current OMP
// lacks Pi's edit/write definition factories while Pi has them.
const isOmpRuntime = process.env.OMPCODE === "1" &&
  typeof piCodingAgent.createEditToolDefinition !== "function";

type CalmUiContext = {
  ui: {
    getEditorText?: () => string;
    getToolsExpanded?: () => boolean;
    onTerminalInput?: (handler: (data: string) => void) => (() => void) | void;
    setHiddenThinkingLabel?: (label: string | undefined) => void;
    setStatus?: (key: string, value: string | undefined) => void;
    setToolsExpanded?: (expanded: boolean) => void;
    setWorkingVisible?: (visible: boolean) => void;
  };
};

const missingCalmUiCapabilityWarnings = new Set<string>();

// Each presentation adapter probes the exact Pi API it patches. If a future Pi removes
// that API, only the affected adapter degrades; the rest of Calm keeps working.
function installCalmPresentationAdapter(name: string, install: () => void): void {
  try {
    install();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`Firstmate Calm: ${name} presentation adapter unavailable, skipping. ${reason}`);
  }
}

function warnMissingCalmUiCapability(name: string): void {
  if (missingCalmUiCapabilityWarnings.has(name)) return;
  missingCalmUiCapabilityWarnings.add(name);
  console.error(
    `Firstmate Calm: ${name} presentation adapter unavailable, skipping. ` +
      `Firstmate Calm requires ExtensionUIContext.${name}`,
  );
}

function applyCalmUiState(ctx: CalmUiContext, active: boolean): void {
  if (typeof ctx.ui.setWorkingVisible === "function") {
    ctx.ui.setWorkingVisible(true);
  } else {
    warnMissingCalmUiCapability("setWorkingVisible");
  }
  if (typeof ctx.ui.setHiddenThinkingLabel === "function") {
    ctx.ui.setHiddenThinkingLabel(active ? "" : undefined);
  } else {
    warnMissingCalmUiCapability("setHiddenThinkingLabel");
  }
  if (typeof ctx.ui.setStatus === "function") ctx.ui.setStatus("firstmate-calm", undefined);
}

function redrawToolRows(ctx: CalmUiContext): void {
  if (
    typeof ctx.ui.getToolsExpanded !== "function" ||
    typeof ctx.ui.setToolsExpanded !== "function"
  ) {
    return;
  }
  const expanded = ctx.ui.getToolsExpanded();
  ctx.ui.setToolsExpanded(!expanded);
  ctx.ui.setToolsExpanded(expanded);
}

export default async function (pi: ExtensionAPI) {
  if (isOmpRuntime) {
    installCalmPresentationAdapter("omp-collapsed-thinking", installOmpAssistantLayout);
  } else {
    installCalmPresentationAdapter("collapsed-thinking", installCalmAssistantLayout);
  }
  installCalmPresentationAdapter("operational-user-row", installCalmOperationalUserLayout);

  let exportRendering = false;
  let removeTerminalInputHandler: (() => void) | undefined;

  const fmHome = process.env.FM_HOME || process.env.FM_ROOT_OVERRIDE || root;
  const configDirectory = process.env.FM_CONFIG_OVERRIDE || resolve(fmHome, "config");
  const calmPreferencePath = resolve(configDirectory, "calm");
  const loadCalmPreference = (): boolean => {
    try {
      return readFileSync(calmPreferencePath, "utf8").trim() === "on";
    } catch {
      return false;
    }
  };
  const persistCalmPreference = (active: boolean): void => {
    mkdirSync(dirname(calmPreferencePath), { recursive: true });
    const temporaryPath = `${calmPreferencePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, active ? "on\n" : "off\n", {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      renameSync(temporaryPath, calmPreferencePath);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  };

  const publishPresentationState = (): void => {
    pi.events.emit(FIRSTMATE_CALM_PRESENTATION_EVENT, {
      active: calmPresentationIsActive(),
      stockExportRendering: exportRendering,
    });
  };

  registerFirstmateSyntheticPresentation(pi);

  function registerBuiltIn<TParams extends TSchema, TDetails, TState>(
    factory: DefinitionFactory<TParams, TDetails, TState>,
  ): void {
    const definitions = new Map<string, ToolDefinition<TParams, TDetails, TState>>();
    const definitionFor = (cwd: string): ToolDefinition<TParams, TDetails, TState> => {
      let definition = definitions.get(cwd);
      if (!definition) {
        definition = factory(cwd);
        definitions.set(cwd, definition);
      }
      return definition;
    };

    const original = definitionFor(process.cwd());
    const originalRenderCall = original.renderCall;
    const originalRenderResult = original.renderResult;
    const originalSelfShell = original.renderShell === "self";
    const standardShells = new WeakMap<object, StandardShellState>();

    if (!originalRenderCall || !originalRenderResult) {
      throw new Error(`Firstmate calm mode requires both render slots for Pi built-in tool ${original.name}`);
    }

    const shellStateFor = (
      context: RenderContext<TParams, TDetails, TState>,
    ): StandardShellState => {
      const rowState = context.state as object;
      let shellState = standardShells.get(rowState);
      if (!shellState) {
        shellState = {};
        standardShells.set(rowState, shellState);
      }
      return shellState;
    };

    const refreshStandardShell = (
      state: StandardShellState,
      theme: RenderTheme<TParams, TDetails, TState>,
      context: RenderContext<TParams, TDetails, TState>,
    ): Box => {
      const background = context.isPartial
        ? (text: string) => theme.bg("toolPendingBg", text)
        : context.isError
          ? (text: string) => theme.bg("toolErrorBg", text)
          : (text: string) => theme.bg("toolSuccessBg", text);
      const shell = state.shell ?? new Box(1, 1, background);
      state.shell = shell;
      shell.setBgFn(background);
      shell.clear();
      if (state.call) shell.addChild(state.call);
      if (state.result) shell.addChild(state.result);
      return shell;
    };

    pi.registerTool({
      ...original,
      renderShell: "self",

      async execute(toolCallId, params, signal, onUpdate, ctx) {
        return definitionFor(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
      },

      renderCall(
        args: RenderArgs<TParams, TDetails, TState>,
        theme: RenderTheme<TParams, TDetails, TState>,
        context: RenderContext<TParams, TDetails, TState>,
      ) {
        if (exportRendering) return originalRenderCall(args, theme, context);
        if (calmPresentationHides("assistant-tool-call")) return new Container();
        if (originalSelfShell) return originalRenderCall(args, theme, context);

        const state = shellStateFor(context);
        state.call = originalRenderCall(args, theme, {
          ...context,
          lastComponent: state.call,
        });
        return refreshStandardShell(state, theme, context);
      },

      renderResult(
        result: RenderResult<TParams, TDetails, TState>,
        options: ToolRenderResultOptions,
        theme: RenderTheme<TParams, TDetails, TState>,
        context: RenderContext<TParams, TDetails, TState>,
      ) {
        if (exportRendering) return originalRenderResult(result, options, theme, context);
        if (calmPresentationHides("tool-result")) return new Container();
        if (originalSelfShell) return originalRenderResult(result, options, theme, context);

        const state = shellStateFor(context);
        state.result = originalRenderResult(result, options, theme, {
          ...context,
          lastComponent: state.result,
        });
        refreshStandardShell(state, theme, context);
        return new Container();
      },
    });
  }

  const ompRendererExportName = (toolName: string): string =>
    `${toolName.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())}ToolRenderer`;

  function ompSettingsFor(cwd: string): unknown {
    const Settings = piCodingAgent.Settings as
      | { get?: () => unknown; instance?: unknown; new (cwd: string): unknown }
      | undefined;
    if (typeof Settings === "function") return new Settings(cwd);
    const settings = Settings?.get?.() ?? Settings?.instance;
    return settings ?? { get: () => undefined };
  }

  function ompRendererFor(toolName: string, label: string): OmpToolRenderer {
    const exported = piCodingAgent[ompRendererExportName(toolName)] as OmpToolRenderer | undefined;
    if (
      exported &&
      typeof exported.renderCall === "function" &&
      typeof exported.renderResult === "function"
    ) {
      return exported;
    }

    const createShellRenderer = piCodingAgent.createShellRenderer as OmpCreateShellRenderer | undefined;
    if (typeof createShellRenderer !== "function") {
      throw new Error(`Firstmate calm mode requires an OMP renderer for ${toolName}`);
    }
    return createShellRenderer({ resolveTitle: () => label });
  }

  function ompToolSession(cwd: string): OmpToolSession & Record<string, unknown> {
    return {
      cwd,
      enableLsp: true,
      getPlanModeState: () => ({ enabled: false }),
      getSessionSpawns: () => undefined,
      hasUI: true,
      refreshSkills: async () => {},
      settings: ompSettingsFor(cwd),
      taskDepth: 0,
    };
  }

  async function registerOmpBuiltIns(): Promise<void> {
    const builtinTools = piCodingAgent.BUILTIN_TOOLS as Record<string, OmpBuiltinFactory> | undefined;
    if (!builtinTools || typeof builtinTools !== "object") {
      throw new Error("Firstmate calm mode requires OMP BUILTIN_TOOLS");
    }

    let registered = 0;
    const inactive: string[] = [];
    for (const [toolName, factory] of Object.entries(builtinTools)) {
      if (typeof factory !== "function") continue;

      const definitions = new Map<string, Promise<ToolDefinition<TSchema, unknown, unknown> | null>>();
      const definitionFor = (cwd: string): Promise<ToolDefinition<TSchema, unknown, unknown> | null> => {
        const existing = definitions.get(cwd);
        if (existing) return existing;
        const created = Promise.resolve(factory(ompToolSession(cwd)));
        definitions.set(cwd, created);
        return created;
      };

      const original = await definitionFor(process.cwd());
      if (!original) {
        inactive.push(toolName);
        continue;
      }
      if (typeof original.execute !== "function") {
        throw new Error(`Firstmate calm mode requires OMP ${toolName}.execute`);
      }

      const originalRecord = original as unknown as Record<string, unknown>;
      const label = typeof original.label === "string" ? original.label : toolName;
      const renderer =
        typeof original.renderCall === "function" && typeof original.renderResult === "function"
          ? (original as unknown as OmpToolRenderer)
          : ompRendererFor(toolName, label);
      const parameters = original.parameters;
      if (typeof parameters !== "function") {
        throw new Error(`Firstmate calm mode requires OMP ${toolName}.parameters`);
      }
      const description = original.description;
      const summary = original.summary;

      pi.registerTool({
        name: toolName,
        label,
        description:
          typeof description === "string" ? description : `Built-in OMP ${toolName} tool.`,
        parameters,
        summary:
          typeof summary === "string" ? summary : `Use the built-in OMP ${toolName} tool.`,
        approval: originalRecord.approval,
        concurrency: originalRecord.concurrency,
        deferrable: originalRecord.deferrable,
        examples: originalRecord.examples,
        formatApprovalDetails:
          typeof originalRecord.formatApprovalDetails === "function"
            ? originalRecord.formatApprovalDetails.bind(original)
            : originalRecord.formatApprovalDetails,
        intent:
          typeof originalRecord.intent === "function"
            ? originalRecord.intent.bind(original)
            : originalRecord.intent,
        interruptible: originalRecord.interruptible,
        lenientArgValidation: originalRecord.lenientArgValidation,
        loadMode: originalRecord.loadMode,
        strict: originalRecord.strict,
        async execute(toolCallId, params, signal, onUpdate, ctx) {
          const cwd = String((ctx as { cwd?: string }).cwd || process.cwd());
          const definition = await definitionFor(cwd);
          if (!definition || typeof definition.execute !== "function") {
            throw new Error(`Firstmate calm mode could not create OMP built-in tool ${toolName}`);
          }
          return definition.execute(toolCallId, params, signal, onUpdate, ctx);
        },
        renderCall(...args: unknown[]) {
          if (exportRendering) return renderer.renderCall(...args);
          if (calmPresentationHides("assistant-tool-call")) return new Container();
          return renderer.renderCall(...args);
        },
        renderResult(...args: unknown[]) {
          if (exportRendering) return renderer.renderResult(...args);
          if (calmPresentationHides("tool-result")) return new Container();
          return renderer.renderResult(...args);
        },
        mergeCallAndResult: renderer.mergeCallAndResult,
      } as ToolDefinition<TSchema, unknown, unknown> & Record<string, unknown>);
      registered += 1;
    }

    if (registered + inactive.length !== Object.keys(builtinTools).length) {
      throw new Error("Firstmate calm mode did not account for the full OMP BUILTIN_TOOLS registry");
    }
    if (registered === 0) {
      throw new Error("Firstmate calm mode could not compose any OMP built-in renderer tools");
    }
  }

  function registerPiBuiltInFactory(exportName: string): void {
    const factory = piCodingAgent[exportName];
    if (typeof factory !== "function") {
      throw new Error(`Firstmate calm mode requires Pi ${exportName}`);
    }
    registerBuiltIn(factory as DefinitionFactory<TSchema, unknown, unknown>);
  }

  if (isOmpRuntime) {
    await registerOmpBuiltIns();
  } else {
    registerPiBuiltInFactory("createReadToolDefinition");
    registerPiBuiltInFactory("createBashToolDefinition");
    registerPiBuiltInFactory("createEditToolDefinition");
    registerPiBuiltInFactory("createWriteToolDefinition");
    registerPiBuiltInFactory("createGrepToolDefinition");
    registerPiBuiltInFactory("createFindToolDefinition");
    registerPiBuiltInFactory("createLsToolDefinition");
  }

  pi.on("session_start", (_event, ctx) => {
    exportRendering = false;
    setCalmPresentation(loadCalmPreference());
    setCalmStockExportRendering(false);
    publishPresentationState();
    applyCalmUiState(ctx, calmPresentationIsActive());
    removeTerminalInputHandler?.();
    if (typeof ctx.ui.onTerminalInput !== "function") {
      removeTerminalInputHandler = undefined;
      return;
    }
    removeTerminalInputHandler = ctx.ui.onTerminalInput((data) => {
      if (!getKeybindings().matches(data, "tui.input.submit")) return;

      const input = typeof ctx.ui.getEditorText === "function"
        ? ctx.ui.getEditorText().trim()
        : "";
      if (
        input !== "/share" &&
        input !== "/export" &&
        !input.startsWith("/export ")
      ) {
        return;
      }

      exportRendering = true;
      setCalmStockExportRendering(true);
      publishPresentationState();
      setTimeout(() => {
        exportRendering = false;
        setCalmStockExportRendering(false);
        publishPresentationState();
        redrawToolRows(ctx);
      }, 0);
    }) ?? undefined;
  });

  pi.registerCommand("calm", {
    description: "Toggle Firstmate's supported conversation-only transcript presentation.",
    handler: async (_args, ctx) => {
      const active = !calmPresentationIsActive();
      persistCalmPreference(active);
      setCalmPresentation(active);
      publishPresentationState();
      applyCalmUiState(ctx, active);
      redrawToolRows(ctx);
    },
  });
}
