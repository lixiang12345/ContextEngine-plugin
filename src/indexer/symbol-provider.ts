/**
 * Optional external symbol-provider contract. The built-in lightweight
 * parsing stays the default and the fallback: a provider is negotiated at
 * runtime, never a hard dependency, and any failure (missing toolchain,
 * timeout, crash) must leave indexing exactly as capable as before.
 */

export interface SymbolProviderCapabilities {
  /** Stable provider id, e.g. "typescript" or "scip". */
  name: string;
  /** Toolchain version the provider negotiated at detect time. */
  version: string;
  /** Languages the provider can analyze. */
  languages: string[];
  /** Whether definition sites are produced. */
  definitions: boolean;
  /** Whether cross-file reference edges are produced. */
  references: boolean;
  /** Whether import edges are produced. */
  imports: boolean;
}

export type ProvidedSymbolKind =
  | "function"
  | "class"
  | "interface"
  | "enum"
  | "type"
  | "variable"
  | "method";

export interface ProvidedSymbol {
  /** Repository-relative POSIX path. */
  path: string;
  name: string;
  kind: ProvidedSymbolKind;
  startLine: number;
  endLine: number;
  exported: boolean;
}

export interface ProvidedRelation {
  /** Repository-relative POSIX paths. */
  fromPath: string;
  toPath: string;
  kind: "import" | "reference";
  /** Imported/referenced symbol name when known. */
  symbol?: string;
}

export interface SymbolProviderDiagnostics {
  filesAnalyzed: number;
  durationMs: number;
  /** Bounded, credential-free error summaries; analysis continues past them. */
  errors: string[];
}

export interface SymbolProviderResult {
  capabilities: SymbolProviderCapabilities;
  symbols: ProvidedSymbol[];
  relations: ProvidedRelation[];
  diagnostics: SymbolProviderDiagnostics;
}

export interface SymbolProviderAnalyzeOptions {
  signal?: AbortSignal;
  /** Per-analysis wall-clock deadline; exceeding it aborts with a partial,
   * clearly-diagnosed result rather than an error. */
  timeoutMs?: number;
}

export interface SymbolProvider {
  readonly name: string;
  /**
   * Availability negotiation. Returns the capabilities the provider can
   * honor in this environment, or null when its toolchain is unavailable —
   * the caller then falls back to the built-in index without loss.
   */
  detect(root: string): Promise<SymbolProviderCapabilities | null>;
  /**
   * Analyze the given repository-relative files under root. Must never
   * throw for per-file problems; they are reported through diagnostics.
   */
  analyze(
    root: string,
    files: readonly string[],
    options?: SymbolProviderAnalyzeOptions,
  ): Promise<SymbolProviderResult>;
}

/**
 * Resolve a provider by id. Unknown ids and providers whose toolchain is
 * absent both resolve to null so callers keep one uniform fallback path.
 */
export async function resolveSymbolProvider(
  name: string,
  root: string,
): Promise<{ provider: SymbolProvider; capabilities: SymbolProviderCapabilities } | null> {
  let provider: SymbolProvider | null = null;
  if (name === "typescript") {
    const { TypeScriptSymbolProvider } = await import(
      "./typescript-symbol-provider.js"
    );
    provider = new TypeScriptSymbolProvider();
  }
  if (!provider) return null;
  try {
    const capabilities = await provider.detect(root);
    return capabilities ? { provider, capabilities } : null;
  } catch {
    return null;
  }
}
