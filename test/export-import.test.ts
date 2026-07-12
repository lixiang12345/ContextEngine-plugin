import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ContextEngine } from "../src/engine.js";
import { exportIndex, importIndex } from "../src/store/export-import.js";

describe("export/import index", () => {
  let root: string;
  let dataDir: string;

  before(async () => {
    root = mkdtempSync(path.join(tmpdir(), "ce-exp-"));
    dataDir = path.join(root, ".contextengine");
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src", "a.ts"), `export const x = 1;\n`);
    const engine = ContextEngine.open({ root, dataDir });
    await engine.index();
    engine.close();
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("round-trips the sqlite index file", () => {
    const dbPath = path.join(dataDir, "index.db");
    const dest = path.join(root, "shared.db");
    const exp = exportIndex(dbPath, dest);
    assert.equal(exp.ok, true);
    assert.ok(existsSync(dest));

    const otherData = path.join(root, "other-data");
    const imp = importIndex(dest, otherData);
    assert.equal(imp.ok, true);
    assert.ok(existsSync(path.join(otherData, "index.db")));
  });
});
