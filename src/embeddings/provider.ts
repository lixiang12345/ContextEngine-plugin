import type { EmbeddingsConfig } from "../types.js";
import { normalizeOpenAIBaseUrl, openAIEndpoint } from "../util/api-url.js";
import { requestJson } from "../util/http-json.js";

export interface EmbeddingProvider {
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
  /** Query-time embedding with retrieval instruction (Qwen3 / Jina-style). */
  embedQuery?(texts: string[]): Promise<number[][]>;
}

/** Dense vectors returned by providers or loaded from the SQLite float32 BLOB. */
export type EmbeddingVector = number[] | Float32Array;

/** Default instruct for code retrieval queries (Qwen3-Embedding recommended). */
export const CODE_RETRIEVAL_QUERY_INSTRUCT =
  "Instruct: Given a programming task or natural language question about a codebase, retrieve the most relevant source code implementation.\nQuery: ";

/** OpenAI-compatible embeddings API (OpenAI, Azure, Ollama, Voyage-compatible proxies, etc.). */
export class OpenAICompatibleEmbeddings implements EmbeddingProvider {
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly dimensions?: number;
  private readonly queryInstruct: string;
  private readonly sendInputType: boolean;

  constructor(config: EmbeddingsConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = normalizeOpenAIBaseUrl(config.baseUrl);
    this.model = config.model;
    this.dimensions = config.dimensions;
    this.queryInstruct =
      process.env.CONTEXTENGINE_EMBED_QUERY_INSTRUCT?.trim() ||
      CODE_RETRIEVAL_QUERY_INSTRUCT;
    this.sendInputType = /^(1|true|yes|on)$/i.test(
      process.env.CONTEXTENGINE_EMBEDDING_INPUT_TYPE?.trim() || "",
    );
  }

  async embed(texts: string[]): Promise<number[][]> {
    return this.embedRaw(texts, "document");
  }

  async embedQuery(texts: string[]): Promise<number[][]> {
    // Document vectors are stored without instruct; only queries get the prefix.
    const prefixed = texts.map((t) => {
      const body = t.trim();
      if (!body) return body;
      if (body.startsWith("Instruct:") || body.startsWith("Query:")) return body;
      return /\s$/.test(this.queryInstruct)
        ? `${this.queryInstruct}${body}`
        : `${this.queryInstruct}\n${body}`;
    });
    return this.embedRaw(prefixed, "query");
  }

  private async embedRaw(
    texts: string[],
    inputType: "document" | "query",
  ): Promise<number[][]> {
    if (texts.length === 0) return [];
    // Smaller batches avoid OOM on 12GB GPUs when embedding long code chunks.
    let batchSize = Number(process.env.CONTEXTENGINE_EMBED_BATCH || 8);
    if (!Number.isFinite(batchSize) || batchSize < 1) batchSize = 8;
    batchSize = Math.floor(batchSize);
    let maxChars = Number(process.env.CONTEXTENGINE_EMBED_MAX_CHARS || 4000);
    if (!Number.isFinite(maxChars) || maxChars < 100) maxChars = 4000;
    maxChars = Math.floor(maxChars);
    const all: number[][] = [];
    for (let i = 0; i < texts.length; ) {
      const batch = texts
        .slice(i, i + batchSize)
        .map((t) => t.slice(0, maxChars));
      try {
        const vectors = await this.embedBatchOnce(batch, inputType);
        all.push(...vectors);
        i += batchSize;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Adaptive shrink on 5xx / OOM-ish failures
        if (batchSize > 1 && /5\d\d|OOM|memory|Internal/i.test(msg)) {
          batchSize = Math.max(1, Math.floor(batchSize / 2));
          continue;
        }
        throw err;
      }
    }
    return all;
  }

  private async embedBatchOnce(
    batch: string[],
    inputType: "document" | "query",
  ): Promise<number[][]> {
    const body: Record<string, unknown> = {
      model: this.model,
      input: batch,
    };
    if (this.dimensions) body.dimensions = this.dimensions;
    if (this.sendInputType) body.input_type = inputType;

    const json = await requestJson<{
      data: Array<{ embedding: number[]; index: number }>;
    }>(openAIEndpoint(this.baseUrl, "embeddings"), {
      label: "Embedding API",
      apiKey: this.apiKey,
      body,
    });
    if (!Array.isArray(json.data) || json.data.length !== batch.length) {
      throw new Error(
        `Embedding API returned ${json.data?.length ?? 0} vectors for ${batch.length} inputs`,
      );
    }
    const ordered = [...json.data].sort((a, b) => a.index - b.index);
    return ordered.map((row, index) => {
      if (
        row.index !== index ||
        !Array.isArray(row.embedding) ||
        row.embedding.length === 0 ||
        row.embedding.some((value) => !Number.isFinite(value))
      ) {
        throw new Error(`Embedding API returned an invalid vector at index ${index}`);
      }
      return normalize(row.embedding);
    });
  }
}

export function createEmbeddingProvider(
  config: EmbeddingsConfig | undefined,
): EmbeddingProvider | null {
  if (!config?.apiKey) return null;
  return new OpenAICompatibleEmbeddings(config);
}

export function normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum) || 1;
  return v.map((x) => x / norm);
}

export function cosineSimilarity(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
): number {
  if (a.length !== b.length) {
    throw new Error(`Embedding dimension mismatch: ${a.length} !== ${b.length}`);
  }
  const n = a.length;
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

/** Serialize float32 vector to Buffer for SQLite BLOB storage. */
export function vectorToBuffer(v: ArrayLike<number>): Buffer {
  const buf = Buffer.alloc(v.length * 4);
  for (let i = 0; i < v.length; i++) buf.writeFloatLE(v[i], i * 4);
  return buf;
}

export function bufferToVector(buf: Buffer): Float32Array {
  const n = Math.floor(buf.length / 4);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}
