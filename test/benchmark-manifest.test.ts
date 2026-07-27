import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const manifestValidation = import(
  "../scripts/lib/benchmark-manifest.mjs"
) as Promise<{
  validateScaleManifestSchema(value: unknown): void;
}>;
const canonicalManifest = JSON.parse(
  readFileSync(new URL("../benchmarks/scale/manifest.json", import.meta.url), "utf8"),
);

describe("scale benchmark manifest schema", () => {
  it("accepts the canonical production manifest", async () => {
    const { validateScaleManifestSchema } = await manifestValidation;
    assert.doesNotThrow(() => validateScaleManifestSchema(canonicalManifest));
  });

  it("fails closed for misspelled threshold keys", async () => {
    const { validateScaleManifestSchema } = await manifestValidation;
    const manifest = structuredClone(canonicalManifest);
    manifest.thresholds.modes.bm25.minRecallAtk =
      manifest.thresholds.modes.bm25.minRecallAtK;
    delete manifest.thresholds.modes.bm25.minRecallAtK;
    assert.throws(
      () => validateScaleManifestSchema(manifest),
      /thresholds\.modes\.bm25 has unknown key\(s\): minRecallAtk/,
    );
  });

  it("rejects unknown structural keys and invalid threshold values", async () => {
    const { validateScaleManifestSchema } = await manifestValidation;
    const unknownSuite = structuredClone(canonicalManifest);
    unknownSuite.suites[0].maxIndexBytes = 10;
    assert.throws(
      () => validateScaleManifestSchema(unknownSuite),
      /suites\[0\] has unknown key\(s\): maxIndexBytes/,
    );

    const invalidProbability = structuredClone(canonicalManifest);
    invalidProbability.macroThresholds.hybrid.minTop3 = 1.01;
    assert.throws(
      () => validateScaleManifestSchema(invalidProbability),
      /macroThresholds\.hybrid\.minTop3 must be between 0 and 1/,
    );
  });
});
