import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveSymbolProvider } from "../src/indexer/symbol-provider.js";
import { TypeScriptSymbolProvider } from "../src/indexer/typescript-symbol-provider.js";

describe("symbol provider contract", () => {
  let root: string;

  before(() => {
    root = mkdtempSync(path.join(tmpdir(), "ce-symbol-provider-"));
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(
      path.join(root, "src", "ledger.ts"),
      [
        `import { auditEntry } from "./audit.js";`,
        `import helpers from "./helpers.js";`,
        ``,
        `export interface LedgerEntry { amount: number }`,
        `export type LedgerId = string;`,
        `export enum LedgerState { Open, Closed }`,
        `const internalCache = new Map<string, number>();`,
        ``,
        `export class LedgerReconciler {`,
        `  reconcile(entries: LedgerEntry[]) {`,
        `    return entries.length + internalCache.size;`,
        `  }`,
        `}`,
        ``,
        `export function openLedger(id: LedgerId) {`,
        `  return auditEntry(id) + helpers();`,
        `}`,
      ].join("\n"),
    );
    writeFileSync(
      path.join(root, "src", "audit.ts"),
      `export function auditEntry(id: string) { return id.length; }\n`,
    );
    writeFileSync(
      path.join(root, "src", "helpers.ts"),
      `export default function helpers() { return 1; }\n`,
    );
    writeFileSync(path.join(root, "src", "broken.ts"), "export function {{{\n");
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("negotiates capabilities and versions before any analysis", async () => {
    const resolved = await resolveSymbolProvider("typescript", root);
    assert.ok(resolved, "typescript toolchain is available in this repo");
    assert.equal(resolved.capabilities.name, "typescript");
    assert.match(resolved.capabilities.version, /^\d+\.\d+/);
    assert.deepEqual(resolved.capabilities.languages, ["typescript", "javascript"]);
    assert.equal(resolved.capabilities.definitions, true);
    assert.equal(resolved.capabilities.imports, true);
    // The spike is syntax-level: reference edges are explicitly not claimed.
    assert.equal(resolved.capabilities.references, false);
  });

  it("resolves unknown providers to null for a uniform fallback path", async () => {
    assert.equal(await resolveSymbolProvider("gopls", root), null);
    assert.equal(await resolveSymbolProvider("", root), null);
  });

  it("extracts declaration symbols with kind, lines, and export flags", async () => {
    const provider = new TypeScriptSymbolProvider();
    const result = await provider.analyze(root, [
      "src/ledger.ts",
      "src/audit.ts",
      "src/helpers.ts",
    ]);
    const byName = new Map(result.symbols.map((symbol) => [symbol.name, symbol]));
    assert.equal(byName.get("LedgerEntry")?.kind, "interface");
    assert.equal(byName.get("LedgerId")?.kind, "type");
    assert.equal(byName.get("LedgerState")?.kind, "enum");
    assert.equal(byName.get("LedgerReconciler")?.kind, "class");
    assert.equal(byName.get("reconcile")?.kind, "method");
    assert.equal(byName.get("openLedger")?.kind, "function");
    assert.equal(byName.get("openLedger")?.exported, true);
    assert.equal(byName.get("internalCache")?.exported, false);
    const reconciler = byName.get("LedgerReconciler")!;
    assert.ok(reconciler.startLine >= 9 && reconciler.endLine >= reconciler.startLine);
    assert.equal(result.diagnostics.filesAnalyzed, 3);
  });

  it("emits import edges resolved to repository-relative paths", async () => {
    const provider = new TypeScriptSymbolProvider();
    const result = await provider.analyze(root, [
      "src/ledger.ts",
      "src/audit.ts",
      "src/helpers.ts",
    ]);
    const edges = result.relations.map(
      (relation) => `${relation.fromPath} -> ${relation.toPath} (${relation.symbol ?? "*"})`,
    );
    assert.ok(edges.includes("src/ledger.ts -> src/audit.ts (auditEntry)"), edges.join("; "));
    assert.ok(edges.includes("src/ledger.ts -> src/helpers.ts (*)"), edges.join("; "));
    for (const relation of result.relations) {
      assert.equal(relation.kind, "import");
      assert.ok(!relation.toPath.startsWith(".."));
    }
  });

  it("survives per-file failures and keeps analyzing", async () => {
    const provider = new TypeScriptSymbolProvider();
    const result = await provider.analyze(root, [
      "src/broken.ts",
      "src/missing.ts",
      "src/audit.ts",
    ]);
    // A syntactically hostile file may still parse loosely; only the missing
    // file is guaranteed to fail. Analysis must reach the healthy file.
    assert.ok(result.diagnostics.errors.some((entry) => entry.includes("src/missing.ts")));
    assert.ok(result.symbols.some((symbol) => symbol.path === "src/audit.ts"));
  });

  it("refuses files that escape the workspace root", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "ce-symbol-outside-"));
    try {
      writeFileSync(path.join(outside, "secret.ts"), "export const secret = 1;\n");
      symlinkSync(path.join(outside, "secret.ts"), path.join(root, "src", "link.ts"));
      const provider = new TypeScriptSymbolProvider();
      const result = await provider.analyze(root, ["../secret.ts"]);
      assert.equal(result.symbols.length, 0);
      assert.ok(
        result.diagnostics.errors.some((entry) => entry.includes("escapes the workspace root")),
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(path.join(root, "src", "link.ts"), { force: true });
    }
  });

  it("honors the analysis deadline with a diagnosed partial result", async () => {
    const provider = new TypeScriptSymbolProvider();
    await provider.detect(root);
    const files = ["src/ledger.ts", "src/audit.ts", "src/helpers.ts"];
    const result = await provider.analyze(root, files, { timeoutMs: 0 });
    assert.ok(result.diagnostics.filesAnalyzed < files.length);
    assert.ok(
      result.diagnostics.errors.some((entry) => entry.includes("deadline")),
      result.diagnostics.errors.join("; "),
    );
  });
});
