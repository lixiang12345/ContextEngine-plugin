import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resolveEngineConfig } from "../src/config.js";

let previous: string | undefined;

beforeEach(() => {
  previous = process.env.CONTEXTENGINE_MAX_FILE_BYTES;
  delete process.env.CONTEXTENGINE_MAX_FILE_BYTES;
});

afterEach(() => {
  if (previous === undefined) delete process.env.CONTEXTENGINE_MAX_FILE_BYTES;
  else process.env.CONTEXTENGINE_MAX_FILE_BYTES = previous;
});

describe("engine file-size configuration", () => {
  it("keeps the 512 KiB default and accepts an explicit bounded override", () => {
    assert.equal(resolveEngineConfig({ root: process.cwd() }).maxFileBytes, 512 * 1024);
    process.env.CONTEXTENGINE_MAX_FILE_BYTES = String(4 * 1024 * 1024);
    assert.equal(
      resolveEngineConfig({ root: process.cwd() }).maxFileBytes,
      4 * 1024 * 1024,
    );
    assert.equal(
      resolveEngineConfig({ root: process.cwd(), maxFileBytes: 1024 }).maxFileBytes,
      1024,
    );
  });

  it("rejects invalid and unbounded values", () => {
    for (const value of ["0", "-1", "1.5", "not-a-number", String(33 * 1024 * 1024)]) {
      process.env.CONTEXTENGINE_MAX_FILE_BYTES = value;
      assert.throws(
        () => resolveEngineConfig({ root: process.cwd() }),
        /CONTEXTENGINE_MAX_FILE_BYTES must be an integer between/,
      );
    }
  });
});
