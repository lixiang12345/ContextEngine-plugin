import { isIP } from "node:net";
import { normalizeOpenAIBaseUrl } from "../util/api-url.js";

export const PRIVATE_MODEL_URL_OPT_IN =
  "CONTEXTENGINE_HTTP_ALLOW_PRIVATE_MODEL_URLS";

export interface RuntimeModelEndpointPolicyOptions {
  allowPrivateNetwork?: boolean;
  trustedBaseUrls?: Iterable<string>;
}

/**
 * Validate a model endpoint supplied through the mutable HTTP configuration.
 *
 * Startup configuration is an explicit operator trust boundary, so an exact
 * endpoint loaded from the environment may be reused even when it is local.
 * New private-network endpoints require a separate server-side opt-in.
 */
export function validateRuntimeModelBaseUrl(
  raw: string,
  options: RuntimeModelEndpointPolicyOptions = {},
): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Model base URL must be a valid absolute URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Model base URL must use http:// or https://");
  }
  if (url.username || url.password) {
    throw new Error(
      "Model base URL must not include URL credentials; configure API keys separately",
    );
  }

  const normalized = normalizeOpenAIBaseUrl(url.toString());
  const nonPublicReason = nonPublicHostReason(url.hostname);
  if (!nonPublicReason || options.allowPrivateNetwork) return normalized;

  const trusted = new Set<string>();
  for (const value of options.trustedBaseUrls ?? []) {
    const identity = trustedEndpointIdentity(value);
    if (identity) trusted.add(identity);
  }
  if (trusted.has(normalized)) return normalized;

  throw new Error(
    `Model base URL targets ${nonPublicReason}, which is blocked for runtime configuration by default. ` +
      `Configure that exact endpoint at process startup or set ${PRIVATE_MODEL_URL_OPT_IN}=1 in trusted deployments`,
  );
}

function trustedEndpointIdentity(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return normalizeOpenAIBaseUrl(url.toString());
  } catch {
    return null;
  }
}

function nonPublicHostReason(rawHostname: string): string | null {
  const hostname = rawHostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "localhost.localdomain" ||
    hostname.endsWith(".localhost.localdomain")
  ) {
    return "a loopback hostname";
  }
  if (hostname.endsWith(".local")) return "a link-local hostname";
  if (
    hostname.endsWith(".internal") ||
    hostname.endsWith(".localdomain") ||
    hostname.endsWith(".lan") ||
    hostname.endsWith(".home.arpa")
  ) {
    return "a local network hostname";
  }

  const ipVersion = isIP(hostname);
  if (ipVersion === 4) return nonPublicIpv4Reason(hostname);
  if (ipVersion === 6) return nonPublicIpv6Reason(hostname);

  // Single-label names normally resolve through local DNS/search domains and
  // are not suitable as remotely supplied network destinations.
  if (!hostname.includes(".")) return "a local network hostname";
  return null;
}

function nonPublicIpv4Reason(hostname: string): string | null {
  const octets = hostname.split(".").map(Number);
  const [a, b] = octets;
  if (a === 0) return "an unspecified or reserved IPv4 address";
  if (a === 10) return "a private IPv4 address";
  if (a === 100 && b >= 64 && b <= 127) {
    return "a shared-address-space IPv4 address";
  }
  if (a === 127) return "a loopback IPv4 address";
  if (a === 169 && b === 254) return "a link-local IPv4 address";
  if (a === 172 && b >= 16 && b <= 31) return "a private IPv4 address";
  if (a === 192 && b === 168) return "a private IPv4 address";
  if (a === 198 && (b === 18 || b === 19)) {
    return "a benchmark-network IPv4 address";
  }
  if (a >= 224) return "a multicast or reserved IPv4 address";
  return null;
}

function nonPublicIpv6Reason(hostname: string): string | null {
  const address = ipv6ToBigInt(hostname);
  if (address === null) return "a non-public IPv6 address";
  if (address === 0n) return "the unspecified IPv6 address";
  if (address === 1n) return "the IPv6 loopback address";

  const firstByte = Number(address >> 120n);
  const firstTenBits = Number(address >> 118n);
  if ((firstByte & 0xfe) === 0xfc) return "a unique-local IPv6 address";
  if (firstTenBits === 0x3fa) return "a link-local IPv6 address";
  if (firstTenBits === 0x3fb) return "a site-local IPv6 address";
  if (firstByte === 0xff) return "a multicast IPv6 address";

  const upper96Bits = address >> 32n;
  if (upper96Bits === 0n || upper96Bits === 0xffffn) {
    const embedded = Number(address & 0xffff_ffffn);
    const ipv4 = [
      (embedded >>> 24) & 0xff,
      (embedded >>> 16) & 0xff,
      (embedded >>> 8) & 0xff,
      embedded & 0xff,
    ].join(".");
    return nonPublicIpv4Reason(ipv4);
  }
  return null;
}

function ipv6ToBigInt(hostname: string): bigint | null {
  const halves = hostname.toLowerCase().split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (
    (halves.length === 1 && missing !== 0) ||
    (halves.length === 2 && missing < 1)
  ) {
    return null;
  }
  const groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))
  ) {
    return null;
  }
  return groups.reduce(
    (value, group) => (value << 16n) | BigInt(`0x${group}`),
    0n,
  );
}
