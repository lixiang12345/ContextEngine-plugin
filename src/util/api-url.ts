const OPENAI_ENDPOINT_SUFFIX = /\/(?:embeddings|rerank|models)$/i;
const VERSION_SUFFIX = /\/v\d+(?:\.\d+)?$/i;

/**
 * Accept either an API origin, a /v1 base URL, or a concrete endpoint URL.
 * ContextEngine stores the normalized OpenAI-compatible base ending in /v1.
 */
export function normalizeOpenAIBaseUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return value;

  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    let pathname = url.pathname.replace(/\/+$/, "");
    pathname = pathname.replace(OPENAI_ENDPOINT_SUFFIX, "");
    if (!VERSION_SUFFIX.test(pathname)) pathname = `${pathname}/v1`;
    url.pathname = pathname.replace(/\/{2,}/g, "/");
    return url.toString().replace(/\/+$/, "");
  } catch {
    let normalized = value.replace(/[?#].*$/, "").replace(/\/+$/, "");
    normalized = normalized.replace(OPENAI_ENDPOINT_SUFFIX, "");
    if (!VERSION_SUFFIX.test(normalized)) normalized = `${normalized}/v1`;
    return normalized;
  }
}

export function openAIEndpoint(baseUrl: string, endpoint: string): string {
  return `${normalizeOpenAIBaseUrl(baseUrl)}/${endpoint.replace(/^\/+/, "")}`;
}

export function apiOriginFromBaseUrl(baseUrl: string): string {
  return normalizeOpenAIBaseUrl(baseUrl).replace(VERSION_SUFFIX, "");
}
