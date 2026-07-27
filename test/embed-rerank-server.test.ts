import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = path.join(root, "scripts", "embed_rerank_server.py");
const source = readFileSync(server, "utf8");

describe("embedding and rerank server accelerator dtype", () => {
  it("pins accelerator inference to fp16 instead of the Qwen BF16 config", () => {
    assert.match(
      source,
      /return torch\.float16 if DEVICE in \{"cuda", "mps"\} else torch\.float32/,
    );
  });

  it("passes the explicit dtype to both model loaders and health", () => {
    assert.equal(
      source.match(/model_kwargs=\{"torch_dtype": INFERENCE_DTYPE\}/g)?.length,
      1,
    );
    assert.equal(
      source.match(/"model_kwargs": \{"torch_dtype": INFERENCE_DTYPE\}/g)
        ?.length,
      1,
    );
    assert.match(source, /"inference_dtype": str\(INFERENCE_DTYPE\)/);
  });
});
