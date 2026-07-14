type HealthRecord = Record<string, unknown>;

function asRecord(value: unknown): HealthRecord | undefined {
  return value && typeof value === "object"
    ? (value as HealthRecord)
    : undefined;
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** Supports the bundled server and the deployed v2 public API health schemas. */
export function isEmbeddingReady(health: unknown): boolean {
  const value = asRecord(health);
  if (!value) return false;
  return (
    (value.ok === true && value.embed_loaded === true) ||
    (value.status === "ok" && nonEmptyString(value.embedding_model))
  );
}

/** Supports the bundled server and the deployed v2 public API health schemas. */
export function isRerankReady(health: unknown): boolean {
  const value = asRecord(health);
  if (!value) return false;
  return (
    (value.ok === true && value.rerank_loaded === true) ||
    (value.status === "ok" && nonEmptyString(value.reranker_model))
  );
}
