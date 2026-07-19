import {
  OpenAICompatibleEmbeddings,
} from "../embeddings/provider.js";
import {
  neuralRerankScores,
  type NeuralRerankConfig,
} from "../search/neural-rerank.js";
import type { EmbeddingsConfig } from "../types.js";

const TEST_TIMEOUT_MS = 45_000;

export interface EmbeddingConnectionTestOptions {
  inputType: boolean;
  maxInputChars: number;
}

export interface ModelConnectionTestResult {
  latencyMs: number;
  model: string;
  details: Record<string, number>;
}

export async function testEmbeddingConnection(
  config: EmbeddingsConfig,
  options: EmbeddingConnectionTestOptions,
): Promise<ModelConnectionTestResult> {
  const provider = new OpenAICompatibleEmbeddings(config, {
    batchSize: 1,
    maxInputChars: options.maxInputChars,
    sendInputType: options.inputType,
    timeoutMs: TEST_TIMEOUT_MS,
    retries: 0,
  });
  const startedAt = performance.now();
  const vectors = await provider.embed([
    "ContextEngine embedding connection test.",
  ]);
  const latencyMs = performance.now() - startedAt;
  const vector = vectors[0];
  if (!vector?.length) {
    throw new Error("Embedding API returned no vector");
  }
  if (config.dimensions && vector.length !== config.dimensions) {
    throw new Error(
      `Embedding dimension mismatch: configured ${config.dimensions}, returned ${vector.length}`,
    );
  }
  return {
    latencyMs,
    model: config.model,
    details: {
      dimensions: vector.length,
      vectors: vectors.length,
    },
  };
}

export async function testRerankerConnection(
  config: NeuralRerankConfig,
): Promise<ModelConnectionTestResult> {
  const documents = [
    {
      id: "relevant",
      text: "function requirePermission(user, permission) { return user.permissions.includes(permission); }",
    },
    {
      id: "irrelevant",
      text: "function formatInvoiceDate(date) { return date.toISOString(); }",
    },
  ];
  const startedAt = performance.now();
  const scores = await neuralRerankScores(
    config,
    "Find the code that checks whether a user has a required permission.",
    documents,
    {
      timeoutMs: TEST_TIMEOUT_MS,
      retries: 0,
      requireScores: true,
    },
  );
  const latencyMs = performance.now() - startedAt;
  return {
    latencyMs,
    model: config.model,
    details: {
      scored_documents: scores.size,
    },
  };
}
