/**
 * Shared classification for snapshot object-store failures. Filesystem stores
 * surface NodeJS.ErrnoException codes (ENOSPC, EACCES, …) while the S3 store
 * surfaces AWS SDK error names plus $metadata.httpStatusCode — the same two
 * conventions isMissingObjectError/isConditionalWriteConflict already follow.
 */
export type SnapshotStoreErrorClassification =
  | "permission"
  | "capacity"
  | "timeout"
  | "aborted"
  | "not_found"
  | "transient";

const PERMISSION_CODES = new Set(["EACCES", "EPERM", "EROFS"]);
const PERMISSION_NAMES = new Set([
  "AccessDenied",
  "AccessDeniedException",
  "AllAccessDisabled",
  "InvalidAccessKeyId",
  "SignatureDoesNotMatch",
]);
/** Credential-rotation hiccups self-heal once the SDK refreshes its provider
 * chain, so they must keep retrying even though AWS reports them as 403. */
const ROTATING_CREDENTIAL_NAMES = new Set([
  "ExpiredToken",
  "ExpiredTokenException",
  "TokenRefreshRequired",
  "CredentialsProviderError",
]);
const CAPACITY_CODES = new Set(["ENOSPC", "EDQUOT"]);
const CAPACITY_NAMES = new Set(["QuotaExceeded", "ServiceQuotaExceededException"]);
const TIMEOUT_CODES = new Set(["ETIMEDOUT", "ESOCKETTIMEDOUT", "ERR_SOCKET_CONNECTION_TIMEOUT"]);
const TIMEOUT_NAMES = new Set([
  "TimeoutError",
  "RequestTimeout",
  "RequestTimeoutException",
  "SnapshotStoreTimeoutError",
]);
const NOT_FOUND_CODES = new Set(["ENOENT"]);
const NOT_FOUND_NAMES = new Set(["NoSuchKey", "NotFound", "NoSuchBucket"]);

interface ErrorShape {
  code?: unknown;
  name?: unknown;
  $metadata?: { httpStatusCode?: unknown };
  cause?: unknown;
}

function classifyOne(error: ErrorShape): SnapshotStoreErrorClassification | null {
  const code = typeof error.code === "string" ? error.code : null;
  const name = typeof error.name === "string" ? error.name : null;
  const status =
    typeof error.$metadata?.httpStatusCode === "number"
      ? error.$metadata.httpStatusCode
      : null;
  // Checked before the 401/403 shortcut: AWS reports expired session tokens
  // as 403, but they recover on retry after the provider chain refreshes.
  if (name && ROTATING_CREDENTIAL_NAMES.has(name)) return "transient";
  if (
    (code && PERMISSION_CODES.has(code)) ||
    (name && PERMISSION_NAMES.has(name)) ||
    status === 401 ||
    status === 403
  ) {
    return "permission";
  }
  if (
    (code && CAPACITY_CODES.has(code)) ||
    (name && CAPACITY_NAMES.has(name)) ||
    status === 507
  ) {
    return "capacity";
  }
  if (
    (code && TIMEOUT_CODES.has(code)) ||
    (name && TIMEOUT_NAMES.has(name)) ||
    status === 408
  ) {
    return "timeout";
  }
  if (code === "ABORT_ERR" || name === "AbortError") return "aborted";
  if (
    (code && NOT_FOUND_CODES.has(code)) ||
    (name && NOT_FOUND_NAMES.has(name)) ||
    status === 404
  ) {
    return "not_found";
  }
  return null;
}

export function classifySnapshotStoreError(
  error: unknown,
): SnapshotStoreErrorClassification {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const classified = classifyOne(current as ErrorShape);
    if (classified) return classified;
    current = (current as ErrorShape).cause;
  }
  return "transient";
}

/** Capacity and permission failures cannot succeed on retry with the same
 * configuration, so snapshot jobs must fail fast instead of burning the
 * retry budget. */
export function isNonRetryableSnapshotStoreError(error: unknown): boolean {
  const classification = classifySnapshotStoreError(error);
  return classification === "permission" || classification === "capacity";
}
