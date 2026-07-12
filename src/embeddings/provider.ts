import type { EmbeddingsConfig } from "../types.js";

export interface EmbeddingProvider {
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

/** OpenAI-compatible embeddings API (OpenAI, Azure, Ollama, Voyage-compatible proxies, etc.). */
export class OpenAICompatibleEmbeddings implements EmbeddingProvider {
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly dimensions?: number;

  constructor(config: EmbeddingsConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.model = config.model;
    this.dimensions = config.dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    // Batch to avoid oversized payloads
    const batchSize = 64;
    const all: number[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize).map((t) => t.slice(0, 8000));
      const body: Record<string, unknown> = {
        model: this.model,
        input: batch,
      };
      if (this.dimensions) body.dimensions = this.dimensions;

      const res = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(
          `Embedding API ${res.status}: ${errText.slice(0, 400)}`,
        );
      }
      const json = (await res.json()) as {
        data: Array<{ embedding: number[]; index: number }>;
      };
      const ordered = [...json.data].sort((a, b) => a.index - b.index);
      for (const row of ordered) {
        all.push(normalize(row.embedding));
      }
    }
    return all;
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

export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

/** Serialize float32 vector to Buffer for SQLite BLOB storage. */
export function vectorToBuffer(v: number[]): Buffer {
  const buf = Buffer.alloc(v.length * 4);
  for (let i = 0; i < v.length; i++) buf.writeFloatLE(v[i], i * 4);
  return buf;
}

export function bufferToVector(buf: Buffer): number[] {
  const n = Math.floor(buf.length / 4);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}
