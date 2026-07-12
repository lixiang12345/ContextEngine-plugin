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
});
