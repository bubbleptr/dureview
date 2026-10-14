import type { ModelThinkingLevel, Models } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";

type ModelLookup = Pick<Models, "getModel">;

/**
 * Reject a model the active provider does not expose, and a thinking level
 * that model does not support. `clampThinkingLevel` is the second check:
 * a level that would be rewritten is not accepted.
 */
export function modelChoiceError(
  models: ModelLookup,
  provider: string,
  modelId: string,
  thinking: ModelThinkingLevel,
): string | null {
  const model = models.getModel(provider, modelId);
  if (!model) return `Unknown model ${provider}/${modelId}.`;
  const supported = getSupportedThinkingLevels(model);
  if (!supported.includes(thinking) || clampThinkingLevel(model, thinking) !== thinking) {
    const list = supported.join(", ");
    return `Thinking level ${thinking} is not supported by ${provider}/${modelId}. Supported levels: ${list}.`;
  }
  return null;
}

export function thinkingLevelsFor(models: ModelLookup, provider: string, modelId: string): ModelThinkingLevel[] {
  const model = models.getModel(provider, modelId);
  if (!model) return [];
  return getSupportedThinkingLevels(model);
}
