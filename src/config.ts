import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { EmbeddingsConfig, EngineConfig } from "./types.js";
import {
  resolveNeuralRerankConfig,
  type NeuralRerankConfig,
} from "./search/neural-rerank.js";

export type { NeuralRerankConfig };
export { resolveNeuralRerankConfig };

const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_CHUNK_CHARS = 2400;

/** Load KEY=VALUE pairs from a .env file if present (no dependency). */
export function loadDotEnv(cwd: string = process.cwd()): void {
  const envPath = path.join(cwd, ".env");
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function resolveEmbeddingsConfig(): EmbeddingsConfig | undefined {
  const apiKey =
    process.env.CONTEXTENGINE_EMBEDDING_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.EMBEDDING_API_KEY;
  if (!apiKey) return undefined;

  const baseUrl = (
    process.env.CONTEXTENGINE_EMBEDDING_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    "https://api.openai.com/v1"
  ).replace(/\/$/, "");

  const model =
    process.env.CONTEXTENGINE_EMBEDDING_MODEL ||
    process.env.OPENAI_EMBEDDING_MODEL ||
    "text-embedding-3-small";

  const dimRaw = process.env.CONTEXTENGINE_EMBEDDING_DIMENSIONS;
  const dimensions = dimRaw ? Number(dimRaw) : undefined;

  return { apiKey, baseUrl, model, dimensions };
}

export function resolveEngineConfig(opts: {
  root?: string;
  dataDir?: string;
  maxFileBytes?: number;
  maxChunkChars?: number;
  extraRoots?: import("./types.js").IndexRoot[];
  extraIgnores?: string[];
}): EngineConfig {
  const root = path.resolve(opts.root ?? process.cwd());
  const dataDir = path.resolve(
    opts.dataDir ?? path.join(root, ".contextengine"),
  );
  return {
    root,
    dataDir,
    extraRoots: opts.extraRoots,
    extraIgnores: opts.extraIgnores,
    embeddings: resolveEmbeddingsConfig(),
    neuralRerank: resolveNeuralRerankConfig(),
    maxFileBytes: opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    maxChunkChars: opts.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS,
  };
}

export function dbPathFor(dataDir: string): string {
  return path.join(dataDir, "index.db");
}
