/**
 * Optional neural cross-encoder / listwise rerank via OpenAI-compatible HTTP.
 *
 * Works with:
 * - scripts/embed_rerank_server.py  POST /v1/rerank
 * - Jina / Cohere-style proxies that return { results: [{ index, relevance_score }] }
 */
import { normalizeOpenAIBaseUrl, openAIEndpoint } from "../util/api-url.js";
import { requestJson } from "../util/http-json.js";

export interface NeuralRerankConfig {
  apiKey: string;
  /** Base URL ending with /v1 (same shape as embeddings). */
  baseUrl: string;
  model: string;
  /** How many top candidates to send (default 20). */
  topN: number;
  /**
   * Blend weight into final score after feature fusion (0–1).
   * final' = (1-w)*final + w*neuralNorm
   */
  weight: number;
  /** Max chars of document text sent to the reranker. */
  maxDocChars: number;
  /** Optional task instruction for providers that expose it. */
  instruction?: string;
}

export interface NeuralDoc {
  id: string;
  text: string;
}

function truthy(v: string | undefined): boolean {
  if (!v) return false;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

/**
 * Resolve neural rerank config from env.
 * Enabled only when CONTEXTENGINE_NEURAL_RERANK=1 (or true/yes/on).
 * Reuses embedding credentials by default.
 */
export function resolveNeuralRerankConfig(): NeuralRerankConfig | undefined {
  if (!truthy(process.env.CONTEXTENGINE_NEURAL_RERANK)) return undefined;

  const apiKey =
    process.env.CONTEXTENGINE_RERANK_API_KEY ||
    process.env.CONTEXTENGINE_EMBEDDING_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.EMBEDDING_API_KEY;
  if (!apiKey) return undefined;

  const baseUrl = (
    process.env.CONTEXTENGINE_RERANK_BASE_URL ||
    process.env.CONTEXTENGINE_EMBEDDING_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    "https://api.openai.com/v1"
  );

  const model =
    process.env.CONTEXTENGINE_RERANK_MODEL ||
    process.env.OPENAI_RERANK_MODEL ||
    "Qwen/Qwen3-Reranker-0.6B";

  let topN = Number(process.env.CONTEXTENGINE_RERANK_TOP_N || 20);
  if (!Number.isFinite(topN) || topN < 2) topN = 20;
  topN = Math.min(64, Math.floor(topN));

  let weight = Number(process.env.CONTEXTENGINE_RERANK_WEIGHT || 0.32);
  if (!Number.isFinite(weight)) weight = 0.32;
  weight = Math.min(0.85, Math.max(0.05, weight));

  let maxDocChars = Number(process.env.CONTEXTENGINE_RERANK_MAX_CHARS || 1800);
  if (!Number.isFinite(maxDocChars) || maxDocChars < 200) maxDocChars = 1800;
  const instruction = process.env.CONTEXTENGINE_RERANK_INSTRUCTION?.trim();

  return {
    apiKey,
    baseUrl: normalizeOpenAIBaseUrl(baseUrl),
    model,
    topN,
    weight,
    maxDocChars,
    instruction: instruction || undefined,
  };
}

/** Build a compact document string for cross-encoder input. */
export function formatRerankDocument(opts: {
  path: string;
  symbol?: string;
  language?: string;
  content: string;
  maxChars: number;
}): string {
  const head = [
    `path: ${opts.path}`,
    opts.symbol ? `symbol: ${opts.symbol}` : "",
    opts.language ? `language: ${opts.language}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const body = (opts.content || "").replace(/\s+/g, " ").trim();
  const text = `${head}\n${body}`;
  return text.length <= opts.maxChars
    ? text
    : text.slice(0, opts.maxChars - 1) + "…";
}

/**
 * Call /v1/rerank and return id → relevance score (raw, higher better).
 * Failures throw; caller should catch and fall back.
 */
export async function neuralRerankScores(
  config: NeuralRerankConfig,
  query: string,
  docs: NeuralDoc[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!query.trim() || docs.length === 0) return out;

  const body = {
    model: config.model,
    query,
    documents: docs.map((d) => d.text),
    top_n: docs.length,
    ...(config.instruction ? { instruction: config.instruction } : {}),
  };

  const json = await requestJson<{
    results?: Array<{
      index?: number;
      relevance_score?: number;
      score?: number;
    }>;
    data?: Array<{ index?: number; score?: number; relevance_score?: number }>;
  }>(openAIEndpoint(config.baseUrl, "rerank"), {
    label: "Rerank API",
    apiKey: config.apiKey,
    body,
  });

  const rows = json.results ?? json.data ?? [];
  for (const row of rows) {
    const idx = row.index;
    if (idx === undefined || idx < 0 || idx >= docs.length) continue;
    const score = row.relevance_score ?? row.score;
    if (typeof score !== "number" || !Number.isFinite(score)) continue;
    out.set(docs[idx].id, score);
  }

  // If API returned nothing usable, assign zeros (caller keeps prior ranking)
  if (out.size === 0) {
    for (const d of docs) out.set(d.id, 0);
  }
  return out;
}

/**
 * Blend neural scores into candidates' final scores (in place).
 * neuralNorm is min-max normalized across the scored set.
 */
export function blendNeuralScores(
  candidates: Array<{ id: string; final: number; channels: { neural?: number } }>,
  scores: Map<string, number>,
  weight: number,
): void {
  if (scores.size === 0 || weight <= 0) return;
  let min = Infinity;
  let max = -Infinity;
  for (const c of candidates) {
    const s = scores.get(c.id);
    if (s === undefined) continue;
    min = Math.min(min, s);
    max = Math.max(max, s);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return;
  const span = max - min;
  for (const c of candidates) {
    const raw = scores.get(c.id);
    if (raw === undefined) continue;
    c.channels.neural = raw;
  }
  // A tied score set carries no ordering signal. Preserve the hybrid ranking
  // instead of shrinking every final score by the rerank blend weight.
  if (span <= 1e-9) return;
  for (const c of candidates) {
    const raw = scores.get(c.id);
    if (raw === undefined) continue;
    const n = (raw - min) / span;
    c.final = (1 - weight) * c.final + weight * n;
  }
}
