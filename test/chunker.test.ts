import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chunkFile } from "../src/chunker/code-chunker.js";

describe("chunkFile", () => {
  it("splits TypeScript by top-level declarations", () => {
    const src = `
export function alpha() {
  return 1;
}

export function beta() {
  return 2;
}

export class Gamma {
  x = 1;
}
`.trim();
    const chunks = chunkFile("src/demo.ts", src, 2400);
    assert.ok(chunks.length >= 2);
    assert.equal(chunks[0].path, "src/demo.ts");
    assert.equal(chunks[0].language, "typescript");
    assert.ok(chunks[0].startLine >= 1);
    assert.ok(chunks[0].endLine >= chunks[0].startLine);
  });

  it("handles markdown headings", () => {
    const md = `# Title\n\nHello\n\n## Section\n\nBody\n`;
    const chunks = chunkFile("README.md", md, 2400);
    assert.ok(chunks.length >= 1);
    assert.equal(chunks[0].language, "markdown");
  });

  it("returns empty for empty content", () => {
    assert.deepEqual(chunkFile("x.ts", "   ", 1000), []);
  });

  it("does not close a Kotlin class on a constructor default lambda", () => {
    const src = `
class ContextEngineClient(
    private val runtimeSettings: () -> RuntimeSettings = {
        RuntimeSettings("node")
    },
  ) {
    fun restart() {
      stopProcess()
    }

    private fun ensureStarted() {
      println("started")
    }
  }

  data class RuntimeSettings(val nodePath: String)
  `.trim();

    const chunks = chunkFile("src/ContextEngineClient.kt", src, 2400);
    const indexed = chunks.map((chunk) => chunk.content).join("\n");

    assert.match(indexed, /fun restart/);
    assert.match(indexed, /private fun ensureStarted/);
    assert.ok(
      chunks.some(
        (chunk) =>
          chunk.symbol === "ContextEngineClient" &&
          chunk.content.includes("ensureStarted"),
      ),
    );
  });
});
