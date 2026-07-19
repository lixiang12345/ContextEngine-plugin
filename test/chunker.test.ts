import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chunkFile,
  extractSymbolNames,
} from "../src/chunker/code-chunker.js";

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

  it("extracts class and object member method symbols", () => {
    const js = `
module.exports = class Application {
  listen(...args) {
    return this.callback().listen(...args);
  }

  createContext(req, res) {
    return { req, res };
  }
}

exports.createServer = function createServer() {};
`.trim();
    const java = `
public class UserService {
  public User findUser(String id) {
    return null;
  }

  public void deleteUser(String id) {}
}
`.trim();

    assert.deepEqual(
      new Set(extractSymbolNames(js, "javascript")),
      new Set(["Application", "listen", "createContext", "createServer"]),
    );
    assert.deepEqual(
      new Set(extractSymbolNames(java, "java")),
      new Set(["UserService", "findUser", "deleteUser"]),
    );
  });

  it("splits oversized classes into method-level chunks with parent context", () => {
    const methods = Array.from({ length: 10 }, (_, index) => {
      const n = index + 1;
      return [
        `  public String method${n}(String value) {`,
        `    String result = value + "${n}";`,
        "    if (result.isEmpty()) {",
        `      return "fallback-${n}";`,
        "    }",
        "    return result;",
        "  }",
      ].join("\n");
    }).join("\n\n");
    const src = [
      "package demo;",
      "",
      "public class BigService {",
      "  private final String prefix = \"x\";",
      "",
      methods,
      "}",
    ].join("\n");

    const chunks = chunkFile("src/BigService.java", src, 2400);
    const methodChunk = chunks.find((chunk) => chunk.symbol === "BigService.method4");

    assert.ok(methodChunk, `symbols: ${chunks.map((chunk) => chunk.symbol).join(", ")}`);
    assert.match(methodChunk.content, /Context: BigService/);
    assert.match(methodChunk.content, /method4/);
    assert.doesNotMatch(methodChunk.content, /method1/);
  });

  it("splits oversized JavaScript module objects into member chunks", () => {
    const members = Array.from({ length: 10 }, (_, index) => {
      const n = index + 1;
      return [
        `  route${n}(ctx) {`,
        `    const value = ctx.request.header["x-route-${n}"];`,
        "    if (!value) {",
        "      return null;",
        "    }",
        "    return value;",
        "  },",
      ].join("\n");
    }).join("\n\n");
    const src = ["module.exports = {", members, "};"].join("\n");

    const chunks = chunkFile("lib/routes.js", src, 2400);
    const routeChunk = chunks.find((chunk) => chunk.symbol === "route5");

    assert.ok(routeChunk, `symbols: ${chunks.map((chunk) => chunk.symbol).join(", ")}`);
    assert.match(routeChunk.content, /Context: module\.exports/);
    assert.match(routeChunk.content, /route5/);
    assert.doesNotMatch(routeChunk.content, /route1/);
  });
});
