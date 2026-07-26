import { createRequire } from "node:module";

/** Single source of truth for the runtime-reported version: the package
 * manifest. Hardcoded literals drifted at the 0.5.0 release freeze. */
export const PACKAGE_VERSION: string = (
  createRequire(import.meta.url)("../../package.json") as { version: string }
).version;
