import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { walkSourceFiles } from "../src/util/fs.js";

describe("walkSourceFiles ignore rules", () => {
  let root: string;

  before(() => {
    root = mkdtempSync(path.join(tmpdir(), "ce-ignore-"));
    mkdirSync(path.join(root, "src"), { recursive: true });
    mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    mkdirSync(path.join(root, "vendor"), { recursive: true });
    mkdirSync(path.join(root, "build"), { recursive: true });
    mkdirSync(path.join(root, "data"), { recursive: true });
    writeFileSync(path.join(root, "src", "main.java"), "class Main {}");
    writeFileSync(path.join(root, "src", "util.cpp"), "int foo() { return 1; }");
    writeFileSync(path.join(root, "src", "util.h"), "int foo();");
    writeFileSync(path.join(root, "src", "app.c"), "int main() { return 0; }");
    writeFileSync(
      path.join(root, "node_modules", "pkg", "index.js"),
      "module.exports=1",
    );
    writeFileSync(path.join(root, "vendor", "lib.go"), "package vendor");
    writeFileSync(path.join(root, "build", "out.js"), "console.log(1)");
    writeFileSync(path.join(root, ".env"), "SECRET=1");
    writeFileSync(path.join(root, "data", "test.json"), '{"a":1}');
    writeFileSync(path.join(root, ".gitignore"), "data/\n");
    writeFileSync(
      path.join(root, ".augmentignore"),
      "# re-include nothing special\n*.tmp\n",
    );
    writeFileSync(path.join(root, "skip.tmp"), "tmp");
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("indexes java/c/cpp and excludes node_modules vendor build secrets", () => {
    const files = walkSourceFiles(root, 512 * 1024);
    const rels = new Set(files.map((f) => f.relPath));
    assert.ok(rels.has("src/main.java"));
    assert.ok(rels.has("src/util.cpp"));
    assert.ok(rels.has("src/util.h"));
    assert.ok(rels.has("src/app.c"));
    assert.ok(!rels.has("node_modules/pkg/index.js"));
    assert.ok(!rels.has("vendor/lib.go"));
    assert.ok(!rels.has("build/out.js"));
    assert.ok(!rels.has(".env"));
    assert.ok(!rels.has("data/test.json"), "gitignore data/");
    assert.ok(!rels.has("skip.tmp"), "augmentignore *.tmp");
  });

  it("supports extra exclude patterns", () => {
    const files = walkSourceFiles(root, 512 * 1024, {
      extraIgnores: ["src/*.c"],
    });
    const rels = files.map((f) => f.relPath);
    assert.ok(rels.includes("src/main.java"));
    assert.ok(!rels.includes("src/app.c"));
  });

  it("supports ! re-include like Augment .augmentignore", () => {
    // rebuild with re-include of gitignored data/
    writeFileSync(
      path.join(root, ".augmentignore"),
      "!data/\n!data/**\n*.tmp\n",
    );
    const files = walkSourceFiles(root, 512 * 1024);
    const rels = files.map((f) => f.relPath);
    // ignore package: later rules can re-include; gitignore had data/
    // then augmentignore !data/ — should include
    assert.ok(
      rels.includes("data/test.json"),
      `expected data/test.json re-included, got ${rels.join(",")}`,
    );
  });
});
