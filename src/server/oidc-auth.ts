import {
  constants,
  createHash,
  createPublicKey,
  verify as verifySignature,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";
import type { HttpPrincipal } from "./http-auth.js";

const MAX_JWT_BYTES = 16 * 1024;
const MAX_JWKS_BYTES = 1024 * 1024;
const MAX_JWKS_KEYS = 100;
const MAX_SUBJECT_LENGTH = 1_000;
const MIN_CACHE_TTL_MS = 1_000;
const MAX_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const MIN_FETCH_TIMEOUT_MS = 100;
const MAX_FETCH_TIMEOUT_MS = 30_000;

const SUPPORTED_ALGORITHMS = Object.freeze({
  RS256: { hash: "sha256", keyType: "RSA" },
  RS384: { hash: "sha384", keyType: "RSA" },
  RS512: { hash: "sha512", keyType: "RSA" },
  PS256: { hash: "sha256", keyType: "RSA-PSS" },
  PS384: { hash: "sha384", keyType: "RSA-PSS" },
  PS512: { hash: "sha512", keyType: "RSA-PSS" },
  ES256: { hash: "sha256", keyType: "EC", curve: "P-256" },
  ES384: { hash: "sha384", keyType: "EC", curve: "P-384" },
  ES512: { hash: "sha512", keyType: "EC", curve: "P-521" },
} as const);

export type OidcJwtAlgorithm = keyof typeof SUPPORTED_ALGORITHMS;

export interface OidcAuthenticatorOptions {
  readonly issuer: string;
  readonly audience: string | readonly string[];
  /** Explicit JWKS endpoint. When omitted, validated OIDC discovery is used. */
  readonly jwksUri?: string;
  readonly allowedAlgorithms?: readonly OidcJwtAlgorithm[];
  readonly groupsClaim?: string;
  /** Only these server-configured group names grant the operator role. */
  readonly operatorGroups?: readonly string[];
  readonly clockToleranceSeconds?: number;
  readonly jwksCacheTtlMs?: number;
  readonly unknownKidRefreshIntervalMs?: number;
  readonly fetchTimeoutMs?: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

interface JwtHeader {
  readonly alg: OidcJwtAlgorithm;
  readonly kid: string;
}

interface CachedKeys {
  readonly expiresAt: number;
  readonly keys: ReadonlyMap<string, JsonWebKey>;
}

interface CachedDiscovery {
  readonly expiresAt: number;
  readonly jwksUri: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return resolved;
}

function validatedHttpsUrl(value: string, name: string): string {
  if (typeof value !== "string" || value.trim() !== value || !value) {
    throw new Error(`${name} must be a non-empty HTTPS URL`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a non-empty HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${name} must be a non-empty HTTPS URL`);
  }
  return value;
}

function validatedNames(
  values: readonly string[] | undefined,
  name: string,
): readonly string[] {
  const result = new Set<string>();
  for (const value of values ?? []) {
    if (
      typeof value !== "string" ||
      value.trim() !== value ||
      !value ||
      value.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(value)
    ) {
      throw new Error(`${name} contains an invalid value`);
    }
    result.add(value);
  }
  return [...result];
}

function discoveryUri(issuer: string): string {
  const parsed = new URL(issuer);
  const issuerPath = parsed.pathname === "/"
    ? ""
    : parsed.pathname.replace(/\/$/, "");
  return `${parsed.origin}/.well-known/openid-configuration${issuerPath}`;
}

function decodeJsonSegment(segment: string): Record<string, unknown> {
  if (!segment || !/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new Error("JWT segment is malformed");
  }
  const decoded = Buffer.from(segment, "base64url");
  if (decoded.toString("base64url") !== segment) {
    throw new Error("JWT segment is not canonical base64url");
  }
  let value: unknown;
  try {
    value = JSON.parse(decoded.toString("utf8"));
  } catch {
    throw new Error("JWT segment is not valid JSON");
  }
  if (!isRecord(value)) throw new Error("JWT segment must be a JSON object");
  return value;
}

function parseHeader(value: Record<string, unknown>): JwtHeader {
  const { alg, kid, typ } = value;
  if (typeof alg !== "string" || !(alg in SUPPORTED_ALGORITHMS)) {
    throw new Error("JWT algorithm is unsupported");
  }
  if (
    typeof kid !== "string" ||
    !kid ||
    kid.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(kid)
  ) {
    throw new Error("JWT kid is required");
  }
  if (typ !== undefined && typ !== "at+jwt" && typ !== "JWT") {
    throw new Error("JWT typ is invalid for an access token");
  }
  return { alg: alg as OidcJwtAlgorithm, kid };
}

function numericDate(value: unknown, name: string, required: boolean): number | null {
  if (value === undefined && !required) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`JWT ${name} claim is invalid`);
  }
  return value;
}

function keyForAlgorithm(jwk: JsonWebKey, algorithm: OidcJwtAlgorithm): KeyObject {
  const expected = SUPPORTED_ALGORITHMS[algorithm];
  if (jwk.use !== undefined && jwk.use !== "sig") {
    throw new Error("JWK is not a signing key");
  }
  if (jwk.key_ops !== undefined && (
    !Array.isArray(jwk.key_ops) ||
    !jwk.key_ops.every((operation) => typeof operation === "string") ||
    !jwk.key_ops.includes("verify")
  )) {
    throw new Error("JWK does not permit signature verification");
  }
  if (jwk.alg !== undefined && jwk.alg !== algorithm) {
    throw new Error("JWK algorithm does not match JWT algorithm");
  }
  if (expected.keyType === "EC") {
    if (jwk.kty !== "EC" || jwk.crv !== expected.curve) {
      throw new Error("JWK curve does not match JWT algorithm");
    }
  } else if (jwk.kty !== "RSA") {
    throw new Error("JWK key type does not match JWT algorithm");
  }
  return createPublicKey({ key: jwk, format: "jwk" });
}

function signatureIsValid(
  algorithm: OidcJwtAlgorithm,
  key: KeyObject,
  signingInput: Buffer,
  signature: Buffer,
): boolean {
  const details = SUPPORTED_ALGORITHMS[algorithm];
  if (details.keyType === "EC") {
    return verifySignature(
      details.hash,
      signingInput,
      { key, dsaEncoding: "ieee-p1363" },
      signature,
    );
  }
  if (details.keyType === "RSA-PSS") {
    return verifySignature(
      details.hash,
      signingInput,
      {
        key,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
      },
      signature,
    );
  }
  return verifySignature(
    details.hash,
    signingInput,
    { key, padding: constants.RSA_PKCS1_PADDING },
    signature,
  );
}

function oidcPrincipalId(issuer: string, subject: string): string {
  const digest = createHash("sha256")
    .update(issuer, "utf8")
    .update("\0", "utf8")
    .update(subject, "utf8")
    .digest("base64url");
  return `oidc:${digest}`;
}

async function boundedResponseText(response: Response): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_JWKS_BYTES) {
      throw new Error("OIDC response is too large");
    }
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JWKS_BYTES) {
        await reader.cancel();
        throw new Error("OIDC response is too large");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

export class OidcJwtAuthenticator {
  private readonly issuer: string;
  private readonly audiences: ReadonlySet<string>;
  private readonly explicitJwksUri: string | null;
  private readonly algorithms: ReadonlySet<OidcJwtAlgorithm>;
  private readonly groupsClaim: string;
  private readonly operatorGroups: ReadonlySet<string>;
  private readonly clockToleranceSeconds: number;
  private readonly jwksCacheTtlMs: number;
  private readonly unknownKidRefreshIntervalMs: number;
  private readonly fetchTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private keyCache: CachedKeys | null = null;
  private discoveryCache: CachedDiscovery | null = null;
  private keyRefresh: Promise<CachedKeys> | null = null;
  private discoveryRefresh: Promise<CachedDiscovery> | null = null;
  private lastUnknownKidRefreshAt = Number.NEGATIVE_INFINITY;

  constructor(options: OidcAuthenticatorOptions) {
    this.issuer = validatedHttpsUrl(options.issuer, "OIDC issuer");
    const audiences = typeof options.audience === "string"
      ? [options.audience]
      : options.audience;
    this.audiences = new Set(validatedNames(audiences, "OIDC audience"));
    if (this.audiences.size === 0) {
      throw new Error("OIDC audience must contain at least one value");
    }
    this.explicitJwksUri = options.jwksUri
      ? validatedHttpsUrl(options.jwksUri, "OIDC JWKS URI")
      : null;
    const algorithms = options.allowedAlgorithms ?? ["RS256"];
    if (algorithms.length === 0) {
      throw new Error("OIDC allowed algorithms must not be empty");
    }
    for (const algorithm of algorithms) {
      if (!(algorithm in SUPPORTED_ALGORITHMS)) {
        throw new Error(`Unsupported OIDC algorithm: ${String(algorithm)}`);
      }
    }
    this.algorithms = new Set(algorithms);
    this.groupsClaim = validatedNames(
      [options.groupsClaim ?? "groups"],
      "OIDC groups claim",
    )[0];
    this.operatorGroups = new Set(
      validatedNames(options.operatorGroups, "OIDC operator groups"),
    );
    this.clockToleranceSeconds = boundedInteger(
      options.clockToleranceSeconds,
      30,
      0,
      300,
      "OIDC clock tolerance seconds",
    );
    this.jwksCacheTtlMs = boundedInteger(
      options.jwksCacheTtlMs,
      5 * 60 * 1_000,
      MIN_CACHE_TTL_MS,
      MAX_CACHE_TTL_MS,
      "OIDC JWKS cache TTL",
    );
    this.unknownKidRefreshIntervalMs = boundedInteger(
      options.unknownKidRefreshIntervalMs,
      30_000,
      MIN_CACHE_TTL_MS,
      this.jwksCacheTtlMs,
      "OIDC unknown kid refresh interval",
    );
    this.fetchTimeoutMs = boundedInteger(
      options.fetchTimeoutMs,
      5_000,
      MIN_FETCH_TIMEOUT_MS,
      MAX_FETCH_TIMEOUT_MS,
      "OIDC fetch timeout",
    );
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") {
      throw new Error("OIDC authentication requires fetch support");
    }
    this.now = options.now ?? Date.now;
  }

  async authenticateToken(token: string): Promise<HttpPrincipal | null> {
    try {
      return await this.verifyToken(token);
    } catch {
      // Authentication failures intentionally collapse to one result so token,
      // claim and key details never reach HTTP responses or application logs.
      return null;
    }
  }

  private async verifyToken(token: string): Promise<HttpPrincipal> {
    if (!token || Buffer.byteLength(token, "utf8") > MAX_JWT_BYTES) {
      throw new Error("JWT size is invalid");
    }
    const segments = token.split(".");
    if (segments.length !== 3) throw new Error("JWT must have three segments");
    const header = parseHeader(decodeJsonSegment(segments[0]));
    if (!this.algorithms.has(header.alg)) {
      throw new Error("JWT algorithm is not allowed");
    }
    const claims = decodeJsonSegment(segments[1]);
    if (!segments[2] || !/^[A-Za-z0-9_-]+$/.test(segments[2])) {
      throw new Error("JWT signature is malformed");
    }
    const signature = Buffer.from(segments[2], "base64url");
    if (signature.toString("base64url") !== segments[2]) {
      throw new Error("JWT signature is not canonical base64url");
    }
    const jwk = await this.findKey(header.kid);
    if (!jwk) throw new Error("JWT signing key is unknown");
    const key = keyForAlgorithm(jwk, header.alg);
    const signingInput = Buffer.from(`${segments[0]}.${segments[1]}`, "ascii");
    if (!signatureIsValid(header.alg, key, signingInput, signature)) {
      throw new Error("JWT signature is invalid");
    }

    if (claims.iss !== this.issuer) throw new Error("JWT issuer is invalid");
    const tokenAudiences = typeof claims.aud === "string"
      ? [claims.aud]
      : Array.isArray(claims.aud) && claims.aud.every((item) => typeof item === "string")
        ? claims.aud as string[]
        : [];
    if (!tokenAudiences.some((audience) => this.audiences.has(audience))) {
      throw new Error("JWT audience is invalid");
    }
    const nowSeconds = this.now() / 1_000;
    const expiresAt = numericDate(claims.exp, "exp", true) as number;
    const notBefore = numericDate(claims.nbf, "nbf", false);
    const issuedAt = numericDate(claims.iat, "iat", false);
    if (expiresAt <= nowSeconds - this.clockToleranceSeconds) {
      throw new Error("JWT is expired");
    }
    if (notBefore !== null && notBefore > nowSeconds + this.clockToleranceSeconds) {
      throw new Error("JWT is not active");
    }
    if (issuedAt !== null && issuedAt > nowSeconds + this.clockToleranceSeconds) {
      throw new Error("JWT issued-at time is in the future");
    }
    if (
      typeof claims.sub !== "string" ||
      !claims.sub ||
      claims.sub.length > MAX_SUBJECT_LENGTH ||
      /[\u0000-\u001f\u007f]/.test(claims.sub)
    ) {
      throw new Error("JWT subject is invalid");
    }

    const rawGroups = claims[this.groupsClaim];
    const groups = typeof rawGroups === "string"
      ? [rawGroups]
      : Array.isArray(rawGroups) && rawGroups.every((item) => typeof item === "string")
        ? rawGroups as string[]
        : [];
    const operator = groups.some((group) => this.operatorGroups.has(group));
    return Object.freeze({
      principalId: oidcPrincipalId(this.issuer, claims.sub),
      role: operator ? "operator" as const : "user" as const,
      admin: operator,
      authenticationMethod: "oidc" as const,
    });
  }

  private async findKey(kid: string): Promise<JsonWebKey | null> {
    let cache = await this.loadKeys(false);
    const existing = cache.keys.get(kid);
    if (existing) return existing;
    const now = this.now();
    if (now - this.lastUnknownKidRefreshAt < this.unknownKidRefreshIntervalMs) {
      return null;
    }
    this.lastUnknownKidRefreshAt = now;
    cache = await this.loadKeys(true);
    return cache.keys.get(kid) ?? null;
  }

  private async loadKeys(force: boolean): Promise<CachedKeys> {
    const now = this.now();
    if (!force && this.keyCache && this.keyCache.expiresAt > now) {
      return this.keyCache;
    }
    if (this.keyRefresh) return this.keyRefresh;
    this.keyRefresh = this.fetchKeys(force);
    try {
      const cache = await this.keyRefresh;
      this.keyCache = cache;
      return cache;
    } finally {
      this.keyRefresh = null;
    }
  }

  private async fetchKeys(forceDiscovery: boolean): Promise<CachedKeys> {
    const jwksUri = await this.resolveJwksUri(forceDiscovery);
    const payload = await this.fetchJson(jwksUri, "OIDC JWKS");
    if (!isRecord(payload) || !Array.isArray(payload.keys)) {
      throw new Error("OIDC JWKS response is invalid");
    }
    if (payload.keys.length === 0 || payload.keys.length > MAX_JWKS_KEYS) {
      throw new Error("OIDC JWKS key count is invalid");
    }
    const keys = new Map<string, JsonWebKey>();
    for (const value of payload.keys) {
      if (!isRecord(value)) throw new Error("OIDC JWK is invalid");
      const kid = value.kid;
      if (
        typeof kid !== "string" ||
        !kid ||
        kid.length > 200 ||
        keys.has(kid)
      ) {
        throw new Error("OIDC JWK kid is missing or duplicated");
      }
      keys.set(kid, value as JsonWebKey);
    }
    return { expiresAt: this.now() + this.jwksCacheTtlMs, keys };
  }

  private async resolveJwksUri(force: boolean): Promise<string> {
    if (this.explicitJwksUri) return this.explicitJwksUri;
    const now = this.now();
    if (!force && this.discoveryCache && this.discoveryCache.expiresAt > now) {
      return this.discoveryCache.jwksUri;
    }
    if (this.discoveryRefresh) return (await this.discoveryRefresh).jwksUri;
    this.discoveryRefresh = this.fetchDiscovery();
    try {
      const cache = await this.discoveryRefresh;
      this.discoveryCache = cache;
      return cache.jwksUri;
    } finally {
      this.discoveryRefresh = null;
    }
  }

  private async fetchDiscovery(): Promise<CachedDiscovery> {
    const payload = await this.fetchJson(discoveryUri(this.issuer), "OIDC discovery");
    if (!isRecord(payload) || payload.issuer !== this.issuer || typeof payload.jwks_uri !== "string") {
      throw new Error("OIDC discovery response is invalid");
    }
    return {
      expiresAt: this.now() + this.jwksCacheTtlMs,
      jwksUri: validatedHttpsUrl(payload.jwks_uri, "Discovered OIDC JWKS URI"),
    };
  }

  private async fetchJson(url: string, description: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
    timer.unref();
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${description} request failed`);
      const text = await boundedResponseText(response);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error(`${description} response is not valid JSON`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
