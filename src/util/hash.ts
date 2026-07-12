import { createHash } from "node:crypto";

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function shortId(...parts: string[]): string {
  return sha256(parts.join("\0")).slice(0, 16);
}
