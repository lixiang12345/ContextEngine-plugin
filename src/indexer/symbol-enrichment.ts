import type { CodeChunk } from "../types.js";
import {
  resolveSymbolProvider,
  type ProvidedSymbol,
  type SymbolProvider,
} from "./symbol-provider.js";

/**
 * Optional provider-backed symbol enrichment for the indexing pipeline.
 * The built-in chunker heuristics stay authoritative: a provider may only
 * fill a chunk's missing `symbol`, never overwrite one. Enrichment runs
 * per re-indexed file, so the existing content-hash incrementality is the
 * cache — an unchanged file is never re-analyzed. Every failure degrades to
 * the built-in behavior; indexing never depends on the provider.
 */

export interface SymbolEnrichmentSummary {
  provider: string;
  version: string;
  filesAnalyzed: number;
  symbolsEnriched: number;
  durationMs: number;
  /** Bounded, credential-free error summaries. */
  errors: string[];
}

const MAX_ERRORS = 8;
const PER_FILE_TIMEOUT_MS = 2_000;

/**
 * Fill missing chunk symbols from provider declarations. For each chunk
 * without a symbol, the overlapping declaration wins by (exported first,
 * then widest line span). Existing symbols are never replaced. Returns how
 * many chunks were enriched.
 */
export function applyProvidedSymbols(
  chunks: CodeChunk[],
  symbols: readonly ProvidedSymbol[],
): number {
  if (!symbols.length) return 0;
  let enriched = 0;
  for (const chunk of chunks) {
    if (chunk.symbol) continue;
    let best: ProvidedSymbol | null = null;
    for (const symbol of symbols) {
      if (symbol.startLine > chunk.endLine || symbol.endLine < chunk.startLine) {
        continue;
      }
      if (
        !best ||
        (symbol.exported && !best.exported) ||
        (symbol.exported === best.exported &&
          symbol.endLine - symbol.startLine > best.endLine - best.startLine)
      ) {
        best = symbol;
      }
    }
    if (best) {
      chunk.symbol = best.name;
      enriched += 1;
    }
  }
  return enriched;
}

export interface SymbolEnricher {
  /** Enrich the chunks of one re-indexed file. Never throws. */
  enrich(relPath: string, chunks: CodeChunk[]): Promise<void>;
  summary(): SymbolEnrichmentSummary;
}

/**
 * Negotiate the configured provider. Returns null — and leaves indexing
 * untouched — when no provider is configured, the id is unknown, or the
 * toolchain is unavailable.
 */
export async function createSymbolEnricher(
  root: string,
  providerName: string | undefined,
): Promise<SymbolEnricher | null> {
  if (!providerName) return null;
  const resolved = await resolveSymbolProvider(providerName, root);
  if (!resolved) return null;
  return new ProviderEnricher(root, resolved.provider, resolved.capabilities.version);
}

class ProviderEnricher implements SymbolEnricher {
  private filesAnalyzed = 0;
  private symbolsEnriched = 0;
  private durationMs = 0;
  private readonly errors: string[] = [];

  constructor(
    private readonly root: string,
    private readonly provider: SymbolProvider,
    private readonly version: string,
  ) {}

  async enrich(relPath: string, chunks: CodeChunk[]): Promise<void> {
    if (!chunks.length || chunks.every((chunk) => chunk.symbol)) return;
    try {
      const result = await this.provider.analyze(this.root, [relPath], {
        timeoutMs: PER_FILE_TIMEOUT_MS,
      });
      this.filesAnalyzed += result.diagnostics.filesAnalyzed;
      this.durationMs += result.diagnostics.durationMs;
      for (const error of result.diagnostics.errors) {
        if (this.errors.length < MAX_ERRORS) this.errors.push(error);
      }
      this.symbolsEnriched += applyProvidedSymbols(chunks, result.symbols);
    } catch (error) {
      if (this.errors.length < MAX_ERRORS) {
        this.errors.push(
          `${relPath}: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`,
        );
      }
    }
  }

  summary(): SymbolEnrichmentSummary {
    return {
      provider: this.provider.name,
      version: this.version,
      filesAnalyzed: this.filesAnalyzed,
      symbolsEnriched: this.symbolsEnriched,
      durationMs: Number(this.durationMs.toFixed(1)),
      errors: this.errors,
    };
  }
}
