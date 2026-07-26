import { readFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type {
  ProvidedRelation,
  ProvidedSymbol,
  ProvidedSymbolKind,
  SymbolProvider,
  SymbolProviderAnalyzeOptions,
  SymbolProviderCapabilities,
  SymbolProviderResult,
} from "./symbol-provider.js";

type TypeScriptModule = typeof import("typescript");

const MAX_ERRORS = 16;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

/**
 * Minimal syntax-level TypeScript provider. It loads the `typescript`
 * package dynamically — present in this repo's dev environment, absent in a
 * production install — so availability is negotiated, never assumed. Files
 * are parsed with createSourceFile (no type checker, no tsconfig): fast,
 * per-file, and safe on arbitrary repositories. Produces exported/local
 * declaration symbols and static import edges; type-checked cross-file
 * references are out of scope for this spike (SCIP territory).
 */
export class TypeScriptSymbolProvider implements SymbolProvider {
  readonly name = "typescript";
  private module: TypeScriptModule | null = null;

  async detect(_root: string): Promise<SymbolProviderCapabilities | null> {
    try {
      this.module = await import("typescript");
    } catch {
      return null;
    }
    return {
      name: this.name,
      version: this.module.version,
      languages: ["typescript", "javascript"],
      definitions: true,
      references: false,
      imports: true,
    };
  }

  async analyze(
    root: string,
    files: readonly string[],
    options?: SymbolProviderAnalyzeOptions,
  ): Promise<SymbolProviderResult> {
    const startedAt = performance.now();
    const ts = this.module ?? (await this.detectModule());
    const capabilities = (await this.detect(root))!;
    const symbols: ProvidedSymbol[] = [];
    const relations: ProvidedRelation[] = [];
    const errors: string[] = [];
    const deadline =
      options?.timeoutMs !== undefined
        ? startedAt + Math.max(1, options.timeoutMs)
        : undefined;
    let filesAnalyzed = 0;
    let timedOut = false;

    const fileSet = new Set(files);
    for (const relPath of files) {
      if (options?.signal?.aborted) break;
      if (deadline !== undefined && performance.now() > deadline) {
        timedOut = true;
        break;
      }
      if (!TS_EXTENSIONS.has(path.extname(relPath))) continue;
      const absolute = path.resolve(root, relPath);
      // Containment: a crafted file list must not read outside the root.
      if (!absolute.startsWith(`${path.resolve(root)}${path.sep}`)) {
        pushBounded(errors, `${relPath}: escapes the workspace root`);
        continue;
      }
      let text: string;
      try {
        text = readFileSync(absolute, "utf8");
      } catch (error) {
        pushBounded(errors, `${relPath}: ${message(error)}`);
        continue;
      }
      if (Buffer.byteLength(text) > MAX_FILE_BYTES) {
        pushBounded(errors, `${relPath}: exceeds the 2 MiB analysis bound`);
        continue;
      }
      try {
        const source = ts.createSourceFile(
          relPath,
          text,
          ts.ScriptTarget.Latest,
          /* setParentNodes */ false,
        );
        this.collect(ts, source, relPath, fileSet, symbols, relations);
        filesAnalyzed += 1;
      } catch (error) {
        pushBounded(errors, `${relPath}: ${message(error)}`);
      }
    }
    if (timedOut) {
      pushBounded(
        errors,
        `analysis stopped at the ${options?.timeoutMs}ms deadline after ${filesAnalyzed} file(s)`,
      );
    }
    return {
      capabilities,
      symbols,
      relations,
      diagnostics: {
        filesAnalyzed,
        durationMs: Number((performance.now() - startedAt).toFixed(1)),
        errors,
      },
    };
  }

  private async detectModule(): Promise<TypeScriptModule> {
    const capabilities = await this.detect("");
    if (!capabilities || !this.module) {
      throw new Error("TypeScript toolchain is unavailable");
    }
    return this.module;
  }

  private collect(
    ts: TypeScriptModule,
    source: import("typescript").SourceFile,
    relPath: string,
    fileSet: ReadonlySet<string>,
    symbols: ProvidedSymbol[],
    relations: ProvidedRelation[],
  ): void {
    const lineOf = (pos: number) =>
      source.getLineAndCharacterOfPosition(pos).line + 1;
    const isExported = (node: import("typescript").Node): boolean => {
      const modifiers = (node as { modifiers?: readonly import("typescript").Node[] })
        .modifiers;
      return Boolean(
        modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
      );
    };
    const pushSymbol = (
      name: string | undefined,
      kind: ProvidedSymbolKind,
      node: import("typescript").Node,
      exported: boolean,
    ) => {
      if (!name) return;
      symbols.push({
        path: relPath,
        name,
        kind,
        startLine: lineOf(node.getStart(source)),
        endLine: lineOf(node.end),
        exported,
      });
    };
    const addImport = (specifier: string, symbol?: string) => {
      if (!specifier.startsWith(".")) return; // package imports carry no repo path
      const resolved = resolveRelativeImport(relPath, specifier, fileSet);
      if (!resolved) return;
      relations.push({ fromPath: relPath, toPath: resolved, kind: "import", symbol });
    };

    for (const statement of source.statements) {
      if (ts.isFunctionDeclaration(statement)) {
        pushSymbol(statement.name?.text, "function", statement, isExported(statement));
      } else if (ts.isClassDeclaration(statement)) {
        const exported = isExported(statement);
        pushSymbol(statement.name?.text, "class", statement, exported);
        for (const member of statement.members) {
          if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name)) {
            pushSymbol(member.name.text, "method", member, exported);
          }
        }
      } else if (ts.isInterfaceDeclaration(statement)) {
        pushSymbol(statement.name.text, "interface", statement, isExported(statement));
      } else if (ts.isEnumDeclaration(statement)) {
        pushSymbol(statement.name.text, "enum", statement, isExported(statement));
      } else if (ts.isTypeAliasDeclaration(statement)) {
        pushSymbol(statement.name.text, "type", statement, isExported(statement));
      } else if (ts.isVariableStatement(statement)) {
        const exported = isExported(statement);
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            pushSymbol(declaration.name.text, "variable", declaration, exported);
          }
        }
      } else if (ts.isImportDeclaration(statement)) {
        if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const specifier = statement.moduleSpecifier.text;
        const clause = statement.importClause;
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) {
            addImport(specifier, element.name.text);
          }
        } else {
          addImport(specifier);
        }
      } else if (ts.isExportDeclaration(statement)) {
        if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
          addImport(statement.moduleSpecifier.text);
        }
      }
    }
  }
}

function resolveRelativeImport(
  fromPath: string,
  specifier: string,
  fileSet: ReadonlySet<string>,
): string | null {
  const base = path.posix.normalize(
    path.posix.join(path.posix.dirname(fromPath), specifier),
  );
  if (base.startsWith("..")) return null;
  const candidates = [
    base,
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.jsx$/, ".tsx"),
    base.replace(/\.mjs$/, ".mts"),
    base.replace(/\.cjs$/, ".cts"),
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
  ];
  for (const candidate of candidates) {
    if (fileSet.has(candidate)) return candidate;
  }
  return null;
}

function pushBounded(errors: string[], entry: string): void {
  if (errors.length < MAX_ERRORS) errors.push(entry);
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 160);
}
