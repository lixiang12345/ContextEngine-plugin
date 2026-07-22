import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  OidcJwtAuthenticator,
  type OidcAuthenticatorOptions,
} from "./oidc-auth.js";

export const LEGACY_HTTP_PRINCIPAL_ID = "legacy-operator";
export const ANONYMOUS_HTTP_PRINCIPAL_ID = "anonymous";

export type HttpPrincipalRole = "user" | "operator";
export type HttpAuthenticationMethod = "bearer" | "oidc" | "anonymous";
export type HttpAuthenticationMode = "bearer" | "anonymous-admin";

export interface HttpPrincipal {
  readonly principalId: string;
  readonly role: HttpPrincipalRole;
  readonly admin: boolean;
  readonly authenticationMethod: HttpAuthenticationMethod;
}

export interface HttpApiKeyConfig {
  readonly principalId: string;
  readonly token: string;
  readonly role?: HttpPrincipalRole;
  readonly admin?: boolean;
}

export interface HttpAuthenticatorOptions {
  /** Legacy single-key configuration. It always maps to an operator principal. */
  readonly apiKey?: string;
  readonly apiKeys?: readonly HttpApiKeyConfig[];
  /**
   * Compatibility mode for explicitly unsecured deployments. It creates an
   * anonymous operator only when no API keys are configured. Configured keys
   * always take precedence and continue to require Bearer authentication.
   */
  readonly allowUnauthenticated?: boolean;
  readonly oidc?: OidcAuthenticatorOptions;
}

export interface HttpAuthenticationPolicy {
  readonly mode: HttpAuthenticationMode;
  readonly authenticationRequired: boolean;
}

export interface HttpRequestAuthenticator {
  readonly policy: HttpAuthenticationPolicy;
  authenticate(
    request: Pick<IncomingMessage, "headers">,
  ): HttpPrincipal | null | Promise<HttpPrincipal | null>;
  authenticateAuthorization(
    authorization: string | readonly string[] | undefined,
  ): HttpPrincipal | null | Promise<HttpPrincipal | null>;
}

interface StoredCredential {
  readonly digest: Buffer;
  readonly principal: HttpPrincipal;
}

const MAX_TOKEN_LENGTH = 4096;
const MAX_PRINCIPAL_ID_LENGTH = 200;
const BEARER_AUTHORIZATION = /^Bearer ([A-Za-z0-9\-._~+/]+={0,})$/i;

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function validatedToken(token: string): string {
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > MAX_TOKEN_LENGTH ||
    !/^[A-Za-z0-9\-._~+/]+={0,}$/.test(token)
  ) {
    throw new Error("HTTP API key token must be a valid Bearer token");
  }
  return token;
}

function validatedPrincipalId(principalId: string): string {
  if (typeof principalId !== "string") {
    throw new Error("HTTP API key principalId is invalid");
  }
  const normalized = principalId.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_PRINCIPAL_ID_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new Error("HTTP API key principalId is invalid");
  }
  return normalized;
}

function configuredPrincipal(config: HttpApiKeyConfig): HttpPrincipal {
  if (
    config.role !== undefined &&
    config.role !== "user" &&
    config.role !== "operator"
  ) {
    throw new Error("HTTP API key role is invalid");
  }
  if (config.admin !== undefined && typeof config.admin !== "boolean") {
    throw new Error("HTTP API key admin flag is invalid");
  }
  const role = config.role ?? (config.admin ? "operator" : "user");
  const admin = role === "operator";
  if (config.admin !== undefined && config.admin !== admin) {
    throw new Error("HTTP API key role and admin settings conflict");
  }
  return Object.freeze({
    principalId: validatedPrincipalId(config.principalId),
    role,
    admin,
    authenticationMethod: "bearer" as const,
  });
}

function legacyPrincipal(): HttpPrincipal {
  return Object.freeze({
    principalId: LEGACY_HTTP_PRINCIPAL_ID,
    role: "operator" as const,
    admin: true,
    authenticationMethod: "bearer" as const,
  });
}

function anonymousPrincipal(): HttpPrincipal {
  return Object.freeze({
    principalId: ANONYMOUS_HTTP_PRINCIPAL_ID,
    role: "operator" as const,
    admin: true,
    authenticationMethod: "anonymous" as const,
  });
}

/** Parse one RFC 6750 Bearer credential without normalizing the token. */
export function parseBearerAuthorization(
  authorization: string | readonly string[] | undefined,
): string | null {
  if (typeof authorization !== "string") return null;
  return BEARER_AUTHORIZATION.exec(authorization)?.[1] ?? null;
}

export class HttpBearerAuthenticator {
  readonly policy: HttpAuthenticationPolicy;

  private readonly credentials: readonly StoredCredential[];
  private readonly unauthenticatedPrincipal: HttpPrincipal | null;

  constructor(options: HttpAuthenticatorOptions) {
    const credentials: StoredCredential[] = [];
    const principalIds = new Set<string>();
    const tokenDigests = new Set<string>();

    const addCredential = (token: string, principal: HttpPrincipal): void => {
      const digest = tokenDigest(validatedToken(token));
      const digestIdentity = digest.toString("hex");
      if (principalIds.has(principal.principalId)) {
        throw new Error("HTTP API key principalId must be unique");
      }
      if (tokenDigests.has(digestIdentity)) {
        throw new Error("HTTP API key token must be unique");
      }
      principalIds.add(principal.principalId);
      tokenDigests.add(digestIdentity);
      credentials.push({ digest, principal });
    };

    if (options.apiKey !== undefined) {
      addCredential(options.apiKey, legacyPrincipal());
    }
    for (const config of options.apiKeys ?? []) {
      addCredential(config.token, configuredPrincipal(config));
    }

    this.credentials = credentials;
    if (credentials.length > 0) {
      this.unauthenticatedPrincipal = null;
      this.policy = Object.freeze({
        mode: "bearer",
        authenticationRequired: true,
      });
      return;
    }
    if (!options.allowUnauthenticated) {
      throw new Error(
        "At least one HTTP API key is required unless unauthenticated access is explicitly enabled",
      );
    }

    this.unauthenticatedPrincipal = anonymousPrincipal();
    this.policy = Object.freeze({
      mode: "anonymous-admin",
      authenticationRequired: false,
    });
  }

  authenticate(
    request: Pick<IncomingMessage, "headers">,
  ): HttpPrincipal | null {
    return this.authenticateAuthorization(request.headers.authorization);
  }

  authenticateAuthorization(
    authorization: string | readonly string[] | undefined,
  ): HttpPrincipal | null {
    if (this.unauthenticatedPrincipal) {
      // Reject supplied credentials in anonymous mode instead of silently
      // accepting a misspelled or stale deployment secret.
      return authorization === undefined ? this.unauthenticatedPrincipal : null;
    }

    const token = parseBearerAuthorization(authorization);
    if (token === null) return null;
    const candidate = tokenDigest(token);
    let matched: HttpPrincipal | null = null;
    for (const credential of this.credentials) {
      if (timingSafeEqual(candidate, credential.digest)) {
        matched = credential.principal;
      }
    }
    return matched;
  }
}

export class HttpCompositeAuthenticator implements HttpRequestAuthenticator {
  readonly policy: HttpAuthenticationPolicy = Object.freeze({
    mode: "bearer",
    authenticationRequired: true,
  });

  constructor(
    private readonly apiKeys: HttpBearerAuthenticator | null,
    private readonly oidc: OidcJwtAuthenticator,
  ) {}

  authenticate(
    request: Pick<IncomingMessage, "headers">,
  ): Promise<HttpPrincipal | null> {
    return this.authenticateAuthorization(request.headers.authorization);
  }

  async authenticateAuthorization(
    authorization: string | readonly string[] | undefined,
  ): Promise<HttpPrincipal | null> {
    const apiKeyPrincipal = this.apiKeys?.authenticateAuthorization(authorization) ?? null;
    if (apiKeyPrincipal) return apiKeyPrincipal;
    const token = parseBearerAuthorization(authorization);
    return token === null ? null : this.oidc.authenticateToken(token);
  }
}

export function createHttpAuthenticator(
  options: HttpAuthenticatorOptions,
): HttpRequestAuthenticator {
  if (options.oidc) {
    const hasApiKeys = options.apiKey !== undefined || (options.apiKeys?.length ?? 0) > 0;
    const apiKeys = hasApiKeys
      ? new HttpBearerAuthenticator({
          apiKey: options.apiKey,
          apiKeys: options.apiKeys,
          allowUnauthenticated: false,
        })
      : null;
    return new HttpCompositeAuthenticator(
      apiKeys,
      new OidcJwtAuthenticator(options.oidc),
    );
  }
  return new HttpBearerAuthenticator(options);
}

export type { OidcAuthenticatorOptions } from "./oidc-auth.js";
