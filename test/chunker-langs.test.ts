import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chunkFile } from "../src/chunker/code-chunker.js";
import { languageForPath } from "../src/util/fs.js";

describe("multi-language chunking", () => {
  it("detects languages", () => {
    assert.equal(languageForPath("Foo.java"), "java");
    assert.equal(languageForPath("a.cpp"), "cpp");
    assert.equal(languageForPath("a.c"), "c");
    assert.equal(languageForPath("a.h"), "c");
    assert.equal(languageForPath("a.hpp"), "cpp");
    assert.equal(languageForPath("Main.swift"), "swift");
    assert.equal(languageForPath("App.cs"), "csharp");
  });

  it("chunks Java classes", () => {
    const src = `
public class Alpha {
  public void run() {}
}

public class Beta {
  int x;
}
`.trim();
    const chunks = chunkFile("src/Demo.java", src, 2400);
    assert.ok(chunks.length >= 1);
    assert.equal(chunks[0].language, "java");
  });

  it("chunks C++ functions", () => {
    const src = `
#include <iostream>

int add(int a, int b) {
  return a + b;
}

int mul(int a, int b) {
  return a * b;
}
`.trim();
    const chunks = chunkFile("src/math.cpp", src, 2400);
    assert.ok(chunks.length >= 1);
    assert.equal(chunks[0].language, "cpp");
  });

  it("chunks C headers/source", () => {
    const src = `
typedef struct Node {
  int v;
} Node;

int node_count(Node* n) {
  return n ? 1 : 0;
}
`.trim();
    const chunks = chunkFile("src/node.c", src, 2400);
    assert.ok(chunks.length >= 1);
    assert.equal(chunks[0].language, "c");
  });
});
