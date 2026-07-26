import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { PACKAGE_VERSION } from "../src/util/version.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestVersion = (
  JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
    version: string;
  }
).version;

describe("reported version", () => {
  it("exposes the package manifest version as the single source of truth", () => {
    assert.equal(PACKAGE_VERSION, manifestVersion);
    assert.match(PACKAGE_VERSION, /^\d+\.\d+\.\d+/);
  });

  it("prints the manifest version from the CLI", async () => {
    // Guards against the hardcoded-literal drift found at the 0.5.0 freeze,
    // where `contextengine --version` still reported 0.4.0.
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", path.join(root, "src/cli.ts"), "--version"],
      { cwd: root },
    );
    assert.equal(stdout.trim(), manifestVersion);
  });
});
