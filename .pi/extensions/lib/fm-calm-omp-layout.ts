// OMP-compatible Calm assistant presentation adapter.
//
// Tool presentation uses the BUILTIN_TOOLS plus standalone renderer composition
// in fm-calm.ts. This file patches only the assistant thinking component OMP
// exports today and lets fm-calm.ts degrade that adapter independently if a
// future OMP removes it.
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import { calmPresentationHides } from "./fm-calm-visibility.ts";

type AssistantMessage = {
  content?: Array<{ type?: string }>;
};

type ComponentConstructor = {
  prototype: Record<string, unknown>;
};

type OmpAssistantPatch = {
  hidesThinking: () => boolean;
};

const OMP_ASSISTANT_PATCH = Symbol.for("firstmate:calm-omp-assistant:17.1.8");

function exportedConstructor(name: string): ComponentConstructor {
  const value = (PiCodingAgent as unknown as Record<string, unknown>)[name];
  if (typeof value !== "function") {
    throw new Error(`Firstmate Calm requires OMP ${name}`);
  }
  return value as ComponentConstructor;
}

export function installOmpAssistantLayout(): void {
  const registry = globalThis as typeof globalThis & {
    [key: symbol]: OmpAssistantPatch | undefined;
  };
  const patch: OmpAssistantPatch = {
    hidesThinking: () => calmPresentationHides("assistant-thinking"),
  };
  const installed = registry[OMP_ASSISTANT_PATCH];
  if (installed) {
    installed.hidesThinking = patch.hidesThinking;
    return;
  }

  const AssistantMessageComponent = exportedConstructor("AssistantMessageComponent");
  const originalUpdateContent = AssistantMessageComponent.prototype.updateContent;
  if (typeof originalUpdateContent !== "function") {
    throw new Error("Firstmate Calm requires OMP AssistantMessageComponent.updateContent");
  }

  AssistantMessageComponent.prototype.updateContent = function (
    message: AssistantMessage,
  ): void {
    const presentationMessage =
      patch.hidesThinking() && Array.isArray(message.content)
        ? {
            ...message,
            content: message.content.filter((block) => block.type !== "thinking"),
          }
        : message;
    originalUpdateContent.call(this, presentationMessage);
  };
  registry[OMP_ASSISTANT_PATCH] = patch;
}
