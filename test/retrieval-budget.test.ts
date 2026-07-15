import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_AUTO_RETRIEVAL_TOKENS,
  resolveRetrievalBudget,
} from "../src/retrieval-budget.js";

describe("retrieval budget", () => {
  it("keeps the 64K baseline at 8K", () => {
    const budget = resolveRetrievalBudget({
      contextWindowTokens: 64_000,
      reservedOutputTokens: 8_192,
    });
    assert.equal(budget.maxTokens, 8_192);
    assert.equal(budget.source, "context-window");
  });

  it("scales sublinearly for current large-context coding models", () => {
    const claude = resolveRetrievalBudget({ contextWindowTokens: 200_000 });
    const gpt = resolveRetrievalBudget({ contextWindowTokens: 400_000 });
    const grok = resolveRetrievalBudget({ contextWindowTokens: 500_000 });

    assert.equal(claude.maxTokens, 15_360);
    assert.equal(gpt.maxTokens, 21_504);
    assert.equal(grok.maxTokens, 24_064);
    assert.ok(claude.maxTokens < gpt.maxTokens);
    assert.ok(gpt.maxTokens < grok.maxTokens);
  });

  it("caps automatic growth and preserves explicit overrides", () => {
    assert.equal(
      resolveRetrievalBudget({ contextWindowTokens: 1_000_000 }).maxTokens,
      MAX_AUTO_RETRIEVAL_TOKENS,
    );
    const explicit = resolveRetrievalBudget({
      contextWindowTokens: 500_000,
      maxTokens: 6_000,
    });
    assert.equal(explicit.maxTokens, 6_000);
    assert.equal(explicit.source, "explicit");
  });
});
