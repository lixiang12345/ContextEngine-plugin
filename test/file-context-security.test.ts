import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ContextEngine } from "../src/engine.js";

describe("ContextEngine file context boundaries", () => {
  let sandbox: string;
  let mainRoot: string;
  let docsRoot: string;
  let outsideRoot: string;
  let engine: ContextEngine;

  before(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), "ce-file-context-"));
    mainRoot = path.join(sandbox, "main");
    docsRoot = path.join(sandbox, "docs");
    outsideRoot = path.join(sandbox, "outside");
    mkdirSync(path.join(mainRoot, "src"), { recursive: true });
    mkdirSync(docsRoot, { recursive: true });
    mkdirSync(outsideRoot, { recursive: true });
    writeFileSync(path.join(mainRoot, "src", "safe.ts"), "one\ntwo\nthree\n");
    writeFileSync(path.join(docsRoot, "guide.md"), "# Safe guide\n");
    writeFileSync(path.join(outsideRoot, "secret.txt"), "outside secret\n");
    symlinkSync(path.join(mainRoot, "src"), path.join(mainRoot, "internal-link"));
    symlinkSync(outsideRoot, path.join(mainRoot, "outside-link"));
    symlinkSync(outsideRoot, path.join(docsRoot, "outside-link"));

    engine = ContextEngine.open({
      root: mainRoot,
      extraRoots: [{ name: "docs", path: docsRoot }],
    });
  });

  after(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("reads files and in-root symlinks within configured roots", () => {
    assert.deepEqual(engine.getFileContext("src/safe.ts", 2, 2), {
      path: "src/safe.ts",
      content: "two",
      startLine: 2,
      endLine: 2,
    });
    assert.equal(
      engine.getFileContext("internal-link/safe.ts")?.content,
      "one\ntwo\nthree\n",
    );
    assert.equal(
      engine.getFileContext("docs/guide.md")?.content,
      "# Safe guide\n",
    );
  });

  it("rejects lexical traversal outside main and extra roots", () => {
    assert.equal(engine.getFileContext("../outside/secret.txt"), null);
    assert.equal(engine.getFileContext("..\\outside\\secret.txt"), null);
    assert.equal(engine.getFileContext("main/../outside/secret.txt"), null);
    assert.equal(engine.getFileContext("docs/../outside/secret.txt"), null);
    assert.equal(
      engine.getFileContext(path.join(outsideRoot, "secret.txt")),
      null,
    );
  });

  it("rejects symlinks whose real target escapes a configured root", () => {
    assert.equal(engine.getFileContext("outside-link/secret.txt"), null);
    assert.equal(engine.getFileContext("main/outside-link/secret.txt"), null);
    assert.equal(engine.getFileContext("docs/outside-link/secret.txt"), null);
  });
});
