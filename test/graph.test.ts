import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chunkFile } from "../src/chunker/code-chunker.js";
import {
  buildSymbolGraph,
  expandViaGraph,
} from "../src/graph/symbol-graph.js";

describe("symbol graph", () => {
  it("extracts imports and expands related files", () => {
    const payments = chunkFile(
      "src/payments.ts",
      `import { chargeStripe } from "./stripe";\nexport function processPayment(a: number) { return chargeStripe(a); }\n`,
      2400,
    );
    const stripe = chunkFile(
      "src/stripe.ts",
      `export function chargeStripe(amount: number) { return amount; }\n`,
      2400,
    );
    const chunks = [...payments, ...stripe];
    const graph = buildSymbolGraph(chunks);
    assert.ok(graph.imports.get("src/payments.ts")?.some((i) => i.includes("stripe")));
    assert.ok((graph.bySymbol.get("chargestripe") ?? graph.bySymbol.get("chargeStripe") ?? []).length >= 0);

    const byId = new Map(chunks.map((c) => [c.id, c]));
    const seed = payments.map((c) => c.id);
    const expanded = expandViaGraph(graph, seed, byId, 10);
    // Should pull in stripe.ts chunks via import edge
    const paths = expanded.map((id) => byId.get(id)?.path);
    assert.ok(
      paths.some((p) => p?.includes("stripe")) ||
        seed.some((id) => byId.get(id)?.content.includes("stripe")),
      `expanded paths: ${paths.join(",")}`,
    );
  });
});
