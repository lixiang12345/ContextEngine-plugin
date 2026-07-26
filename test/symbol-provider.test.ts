import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveSymbolProvider } from "../src/indexer/symbol-provider.js";
import { TypeScriptSymbolProvider } from "../src/indexer/typescript-symbol-provider.js";
import {
  applyProvidedSymbols,
  createSymbolEnricher,
} from "../src/indexer/symbol-enrichment.js";
import { ContextEngine } from "../src/engine.js";
import type { CodeChunk } from "../src/types.js";

function chunk(id: string, startLine: number, endLine: number, symbol?: string): CodeChunk {
  return {
    id,
    path: "src/x.ts",
    language: "ts",
    startLine,
    endLine,
    content: "content",
    symbol,
  };
}

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

  it("fills only missing chunk symbols, preferring exported and wider spans", () => {
    const chunks = [
      chunk("kept", 1, 10, "existingSymbol"),
      chunk("filled", 12, 30),
      chunk("untouched", 40, 50),
    ];
    const enriched = applyProvidedSymbols(chunks, [
      { path: "src/x.ts", name: "narrowLocal", kind: "variable", startLine: 14, endLine: 15, exported: false },
      { path: "src/x.ts", name: "wideExported", kind: "class", startLine: 12, endLine: 28, exported: true },
      { path: "src/x.ts", name: "clobber", kind: "function", startLine: 1, endLine: 10, exported: true },
    ]);
    assert.equal(enriched, 1);
    assert.equal(chunks[0].symbol, "existingSymbol", "existing symbols are never overwritten");
    assert.equal(chunks[1].symbol, "wideExported", "exported wide declaration wins");
    assert.equal(chunks[2].symbol, undefined, "non-overlapping chunks stay untouched");
  });

  it("negotiates to null for unknown providers in the enricher too", async () => {
    assert.equal(await createSymbolEnricher(root, "gopls"), null);
    assert.equal(await createSymbolEnricher(root, undefined), null);
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

const describePostgres =
  process.env.CONTEXTENGINE_TEST_DATABASE_URL ||
  process.env.CONTEXTENGINE_DATABASE_URL
    ? describe
    : describe.skip;

describePostgres("symbol enrichment in the indexing pipeline", () => {
  let root: string;

  before(() => {
    root = mkdtempSync(path.join(tmpdir(), "ce-enrich-"));
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(
      path.join(root, "src", "billing.ts"),
      `export function computeInvoice(total: number) {\n  return total * 1.2;\n}\n`,
    );
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reports a provider summary when configured, none when unknown", async () => {
    const withProvider = ContextEngine.open({
      root,
      dataDir: path.join(root, ".ce-a"),
      symbolProvider: "typescript",
    });
    try {
      const result = await withProvider.index();
      assert.ok(result.chunksWritten >= 1);
      assert.ok(result.symbolProvider, "summary expected when the provider negotiated");
      assert.equal(result.symbolProvider.provider, "typescript");
      assert.match(result.symbolProvider.version, /^\d+\./);
      assert.deepEqual(result.symbolProvider.errors, []);
    } finally {
      await withProvider.close();
    }

    const unknown = ContextEngine.open({
      root,
      dataDir: path.join(root, ".ce-b"),
      symbolProvider: "gopls",
    });
    try {
      // Same workspace, unchanged files: the run is incremental, which is
      // itself the point — indexing completes fine without the provider.
      const result = await unknown.index();
      assert.ok(result.filesScanned >= 1, "indexing must not depend on the provider");
      assert.equal(result.symbolProvider, undefined);
    } finally {
      await unknown.close();
    }
  });
});
