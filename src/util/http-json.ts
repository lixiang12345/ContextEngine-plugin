interface JsonRequestOptions {
  label: string;
  apiKey?: string;
  method?: "GET" | "POST";
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  retries?: number;
}

function boundedEnvNumber(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function retryDelayMs(response: Response | undefined, attempt: number): number {
  const header = response?.headers.get("retry-after");
  const seconds = header ? Number(header) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(5000, Math.floor(seconds * 1000));
  }
  return Math.min(5000, 300 * 2 ** attempt);
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(error: unknown): Error {
  if (!(error instanceof Error)) return new Error(String(error));
  const cause =
    error.cause instanceof Error
      ? error.cause.message
      : typeof error.cause === "string"
        ? error.cause
        : "";
  return cause && !error.message.includes(cause)
    ? new Error(`${error.message}: ${cause}`)
    : error;
}

/** JSON HTTP helper with bounded timeouts and retries for remote GPU gateways. */
export async function requestJson<T>(
  url: string,
  options: JsonRequestOptions,
): Promise<T> {
  const timeoutMs =
    options.timeoutMs ??
    boundedEnvNumber("CONTEXTENGINE_API_TIMEOUT_MS", 120_000, 1000, 600_000);
  const retries =
    options.retries ??
    boundedEnvNumber("CONTEXTENGINE_API_RETRIES", 2, 0, 5);
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let response: Response | undefined;
    try {
      options.signal?.throwIfAborted();
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      response = await fetch(url, {
        method: options.method ?? (options.body === undefined ? "GET" : "POST"),
        // Model endpoints are configured explicitly. Following redirects could
        // turn an approved public URL into a request to a private destination.
        redirect: "error",
        headers: {
          Accept: "application/json",
          ...(options.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
          ...(options.apiKey
            ? { Authorization: `Bearer ${options.apiKey}` }
            : {}),
        },
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal
          ? AbortSignal.any([options.signal, timeoutSignal])
          : timeoutSignal,
      });
      const text = await response.text();
      if (!response.ok) {
        lastError = new Error(
          `${options.label} ${response.status}: ${text.slice(0, 400)}`,
        );
        if (attempt < retries && retryableStatus(response.status)) {
          await sleep(retryDelayMs(response, attempt));
          continue;
        }
        throw lastError;
      }
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error(
          `${options.label} returned invalid JSON: ${text.slice(0, 200)}`,
        );
      }
    } catch (error) {
      lastError = describeError(error);
      if (options.signal?.aborted) throw lastError;
      if (
        attempt < retries &&
        (!response || retryableStatus(response.status))
      ) {
        await sleep(retryDelayMs(response, attempt));
        continue;
      }
      throw lastError;
    }
  }

  throw lastError ?? new Error(`${options.label} failed`);
}
