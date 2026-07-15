export const DEFAULT_CONTEXT_WINDOW_TOKENS = 64_000;
export const DEFAULT_RESERVED_OUTPUT_TOKENS = 8_192;
export const MIN_CONTEXT_WINDOW_TOKENS = 16_384;
export const MAX_CONTEXT_WINDOW_TOKENS = 2_000_000;
export const MIN_RETRIEVAL_TOKENS = 4_096;
export const MAX_AUTO_RETRIEVAL_TOKENS = 24_576;

const BASE_INPUT_TOKENS =
  DEFAULT_CONTEXT_WINDOW_TOKENS - DEFAULT_RESERVED_OUTPUT_TOKENS;
const BASE_RETRIEVAL_TOKENS = 8_192;
const BUDGET_STEP_TOKENS = 512;

export interface RetrievalBudgetOptions {
  maxTokens?: number;
  contextWindowTokens?: number;
  reservedOutputTokens?: number;
}

export interface ResolvedRetrievalBudget {
  maxTokens: number;
  contextWindowTokens: number;
  reservedOutputTokens: number;
  availableInputTokens: number;
  source: "explicit" | "context-window";
}

/**
 * Scale retrieval sublinearly with the model input window.
 *
 * A square-root curve gives larger-context models more evidence without
 * linearly increasing noise, latency, and "lost in the middle" pressure.
 * Explicit maxTokens remains authoritative for callers that need a lower or
 * higher one-off cap.
 */
export function resolveRetrievalBudget(
  options: RetrievalBudgetOptions = {},
): ResolvedRetrievalBudget {
  const contextWindowTokens = boundedInteger(
    options.contextWindowTokens,
    MIN_CONTEXT_WINDOW_TOKENS,
    MAX_CONTEXT_WINDOW_TOKENS,
    DEFAULT_CONTEXT_WINDOW_TOKENS,
  );
  const reservedOutputTokens = boundedInteger(
    options.reservedOutputTokens,
    1_024,
    Math.max(1_024, contextWindowTokens - 1_024),
    Math.min(DEFAULT_RESERVED_OUTPUT_TOKENS, contextWindowTokens - 1_024),
  );
  const availableInputTokens = contextWindowTokens - reservedOutputTokens;

  if (
    options.maxTokens !== undefined &&
    Number.isFinite(options.maxTokens) &&
    options.maxTokens > 0
  ) {
    return {
      maxTokens: Math.floor(options.maxTokens),
      contextWindowTokens,
      reservedOutputTokens,
      availableInputTokens,
      source: "explicit",
    };
  }

  const scaled =
    BASE_RETRIEVAL_TOKENS *
    Math.sqrt(availableInputTokens / BASE_INPUT_TOKENS);
  const stepped =
    Math.round(scaled / BUDGET_STEP_TOKENS) * BUDGET_STEP_TOKENS;
  const maxTokens = Math.min(
    MAX_AUTO_RETRIEVAL_TOKENS,
    Math.max(MIN_RETRIEVAL_TOKENS, stepped),
  );

  return {
    maxTokens,
    contextWindowTokens,
    reservedOutputTokens,
    availableInputTokens,
    source: "context-window",
  };
}

function boundedInteger(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value as number)));
}
