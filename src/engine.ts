import path from "node:path";
import { realpathSync } from "node:fs";
import type {
  EngineConfig,
  IndexRoot,
  IndexStats,
  PackedContext,
  PackingPolicy,
  RetrievalTrace,
  SearchHit,
  SearchOptions,
  TaskContextOptions,
} from "./types.js";
import { resolveEngineConfig } from "./config.js";
import {
  indexWorkspace,
  parseExtraRootsFromEnv,
  type IndexResult,
} from "./indexer/indexer.js";
import { PostgresStore } from "./store/postgres-store.js";
import type { IndexGenerationStatus } from "./store/postgres-store.js";
import { PostgresHybridSearcher } from "./search/postgres-hybrid.js";
import { createEmbeddingProvider } from "./embeddings/provider.js";
import { readTextFile } from "./util/fs.js";
import { analyzeQuery } from "./search/query-analyzer.js";
import {
  loadWorkspaceRules,
  formatRulesSection,
  type WorkspaceRule,
} from "./rules/rules-loader.js";

/**
 * High-level Context Engine API (v0.4 multi-signal retrieval).
 */
export class ContextEngine {
  readonly config: EngineConfig;
  private store: PostgresStore | null = null;
  private storeOpening: Promise<PostgresStore> | null = null;
  private searcher: PostgresHybridSearcher | null = null;
  private refreshOpening: Promise<void> | null = null;
  /** Snapshot used to annotate packed passages without another database call. */
  private indexFreshness: IndexFreshness | undefined;

  constructor(config: EngineConfig) {
    this.config = config;
  }

  static open(opts: {
    root?: string;
    workspaceId?: string;
    dataDir?: string;
    databaseUrl?: string;
    extraRoots?: IndexRoot[];
  } = {}): ContextEngine {
    const cfg = resolveEngineConfig(opts);
    if (opts.extraRoots) cfg.extraRoots = opts.extraRoots;
    else if (!cfg.extraRoots?.length) {
      const envRoots = parseExtraRootsFromEnv();
      if (envRoots.length) cfg.extraRoots = envRoots;
    }
    return new ContextEngine(cfg);
  }

  get dbPath(): string {
    return "PostgreSQL (pgvector)";
  }

  async index(
    onProgress?: Parameters<typeof indexWorkspace>[1],
  ): Promise<IndexResult> {
    await this.close();
    const result = await indexWorkspace(this.config, onProgress);
    await this.reloadSearcher();
    return result;
  }

  async stats(): Promise<IndexStats> {
    await this.ensureCurrentReader();
    const store = await this.ensureStore();
    return store.stats(this.config.root);
  }

  /** Generation identity for provenance on search/context responses. */
  async indexStatus(): Promise<IndexGenerationStatus> {
    await this.ensureCurrentReader();
    const store = await this.ensureStore();
    return store.generationStatus();
  }

  async hasIndex(): Promise<boolean> {
    await this.ensureCurrentReader();
    const store = await this.ensureStore();
    return (await store.chunkCount()) > 0;
  }

  async clearIndex(): Promise<void> {
    await this.ensureCurrentReader();
    const store = await this.ensureStore();
    await store.clearWorkspace();
    this.searcher = null;
    this.indexFreshness = undefined;
  }

  /** Reload database-backed search state after an external index job. */
  async refresh(): Promise<void> {
    // PostgresStore pins a reader to the generation resolved at open time.
    // Reopen it after an external job promotes a new generation; rebuilding
    // only the searcher would keep querying the retired physical namespace.
    if (this.refreshOpening) return this.refreshOpening;
    this.refreshOpening = (async () => {
      await this.close();
      await this.reloadSearcher();
    })().finally(() => {
      this.refreshOpening = null;
    });
    await this.refreshOpening;
  }

  async search(opts: SearchOptions): Promise<SearchHit[]> {
    await this.ensureCurrentReader();
    const store = await this.ensureStore();
    const searcher = await this.ensureSearcher();
    const hits = await searcher.search(opts);
    // A promotion can race the preflight check. Retry once so a response does
    // not pair hits from a retired namespace with fresh provenance metadata.
    if (!(await store.isCurrentGeneration())) {
      await this.refresh();
      return (await this.ensureSearcher()).search(opts);
    }
    return hits;
  }

  /**
   * Pack high-signal context for an engineering task (MMR + optional cap).
   * Primary agent entrypoint — mirrors Augment-style "retrieve then edit".
   */
  async getTaskContext(opts: TaskContextOptions): Promise<PackedContext> {
    const topK = opts.topK ?? 12;
    const maxTokens = normalizeTokenBudget(opts.maxTokens);
    const packing: PackingPolicy = opts.packing ?? "raw";
    const analyzed = analyzeQuery(opts.task);
    const salientTerms =
      packing === "extractive" ? buildSalientTerms(analyzed) : null;

    // Repository conventions (AGENTS.md / CLAUDE.md / .augment/rules …) are
    // grounded ahead of matching code so the agent always sees how the repo
    // wants changes made, not just where the relevant code is. Opt-out via
    // includeRules: false. Only the primary root is scanned.
    const rules: WorkspaceRule[] =
      opts.includeRules === false ? [] : loadWorkspaceRules(this.config.root);

    const hits = await this.search({
      query: opts.task,
      topK,
      pathPrefix: opts.pathPrefix,
      sourceAccess: opts.sourceAccess,
      mode: "auto",
      diversify: opts.diversify !== false,
      includeCommits: analyzed.prefersCommits ? true : undefined,
    });
    const orderedHits = orderContextHits(hits);

    const headerText = [
      `# Task context`,
      ``,
      `Task: ${opts.task}`,
      `Intent: ${analyzed.intent}`,
      analyzed.identifiers.length
        ? `Identifiers: ${analyzed.identifiers.slice(0, 8).join(", ")}`
        : null,
      ``,
      `Retrieved ${hits.length} candidate chunks; packing complementary passages by file.`,
      ``,
    ]
      .filter((x): x is string => x !== null)
      .join("\n");

    const charBudget =
      maxTokens === undefined ? undefined : maxTokens * TOKEN_CHARS;
    const firstProvenanceChars = orderedHits[0]
      ? formatProvenanceOnly(orderedHits[0], this.indexFreshness).length
      : undefined;
    const headerBudget =
      charBudget !== undefined &&
      firstProvenanceChars !== undefined &&
      firstProvenanceChars <= charBudget
        ? Math.max(0, charBudget - firstProvenanceChars - 1)
        : charBudget;
    let packedText = fitTextToCharBudget(headerText, headerBudget);
    let truncated =
      headerBudget !== undefined && packedText.length < headerText.length;

    // Prepend workspace rules under a bounded share of the budget (at most a
    // quarter) so conventions never crowd out the retrieved code evidence.
    if (rules.length && !truncated) {
      const rulesBudget =
        charBudget === undefined
          ? undefined
          : Math.max(0, Math.floor(charBudget / 4) - packedText.length);
      if (rulesBudget === undefined || rulesBudget > 0) {
        const rulesSection = formatRulesSection(rules, rulesBudget);
        if (rulesSection) packedText += `\n${rulesSection}\n`;
      }
    }
    const used: SearchHit[] = [];

    for (const hit of orderedHits) {
      const separator = packedText.length ? "\n" : "";
      const remaining =
        charBudget === undefined
          ? undefined
          : Math.max(0, charBudget - packedText.length - separator.length);
      if (remaining !== undefined && remaining <= 0) {
        truncated = true;
        break;
      }

      const block = formatHitWithinChars(
        hit,
        this.indexFreshness,
        remaining,
        salientTerms,
      );
      if (!block) {
        // There is not enough room for a provenance-bearing block. The
        // caller still gets a hard-capped response rather than an overflow.
        truncated = true;
        break;
      }
      packedText += separator + block.text;
      used.push(hit);
      if (block.truncated) {
        truncated = true;
        // A clean salient-line elision keeps every query-relevant line, so more
        // passages can still be packed. A hard mid-content cut is lossy — stop.
        if (!block.elided) break;
      }
    }

    const estimatedTokens = estimateTokens(packedText);
    const degradedChannels = [
      ...new Set(hits.flatMap((hit) => hit.degradedChannels ?? [])),
    ];
    const channels = [
      ...new Set(
        hits.flatMap((hit) =>
          hit.channels
            ? Object.entries(hit.channels)
                .filter(([, value]) => value !== undefined)
                .map(([name]) => name)
            : [],
        ),
      ),
    ];
    const concepts = [
      ...new Set(
        [...analyzed.identifiers, ...analyzed.expandedTerms]
          .map((term) => term.trim())
          .filter((term) => term.length >= 2),
      ),
    ].slice(0, 12);
    const trace: RetrievalTrace = {
      intent: analyzed.intent,
      concepts,
      channels,
      degradedChannels,
      rules: rules.length
        ? rules.map((rule) => ({ path: rule.path, scope: rule.scope }))
        : undefined,
      candidateCount: hits.length,
      packedCount: used.length,
      fileCount: new Set(used.map((hit) => hit.chunk.path)).size,
      estimatedTokens,
      truncated,
      packing,
      generationId: this.indexFreshness?.generationId,
      indexedRevision: this.indexFreshness?.indexedRevision,
      sourceRevision: this.indexFreshness?.sourceRevision,
      pendingRevision: this.indexFreshness?.pendingRevision,
      indexedAt: this.indexFreshness?.indexedAt,
    };

    return {
      task: opts.task,
      hits: used,
      packedText,
      estimatedTokens,
      truncated,
      degradedChannels: degradedChannels.length ? degradedChannels : undefined,
      packing,
      trace,
    };
  }

  /**
   * Augment-style single-shot codebase retrieval for agents.
   */
  async codebaseRetrieval(
    informationRequest: string,
    opts?: {
      topK?: number;
      maxTokens?: number;
      sourceAccess?: import("./types.js").SourcePathPolicy;
      packing?: PackingPolicy;
      includeRules?: boolean;
    },
  ): Promise<PackedContext> {
    return this.getTaskContext({
      task: informationRequest,
      topK: opts?.topK ?? 14,
      maxTokens: opts?.maxTokens,
      sourceAccess: opts?.sourceAccess,
      diversify: true,
      packing: opts?.packing,
      includeRules: opts?.includeRules,
    });
  }

  getFileContext(
    relPath: string,
    startLine?: number,
    endLine?: number,
  ): { path: string; content: string; startLine: number; endLine: number } | null {
    // Support multi-root prefixed paths: main/src/x.ts or docs/guide.md
    const extras = this.config.extraRoots ?? [];
    if (extras.length > 0 || relPath.includes("/")) {
      const first = relPath.split("/")[0];
      if (first === "main") {
        const rest = relPath.slice("main/".length);
        return readRangeWithinRoot(
          this.config.root,
          rest,
          relPath,
          startLine,
          endLine,
        );
      }
      const match = extras.find((r) => r.name === first);
      if (match) {
        const rest = relPath.slice(first.length + 1);
        return readRangeWithinRoot(
          match.path,
          rest,
          relPath,
          startLine,
          endLine,
        );
      }
    }
    return readRangeWithinRoot(
      this.config.root,
      relPath,
      relPath,
      startLine,
      endLine,
    );
  }

  async close(): Promise<void> {
    const opening = this.storeOpening;
    const store = this.store ?? (opening ? await opening : null);
    this.store = null;
    this.searcher = null;
    this.indexFreshness = undefined;
    if (store) await store.close();
  }

  private async ensureStore(): Promise<PostgresStore> {
    if (this.store) return this.store;
    if (!this.storeOpening) {
      if (!this.config.databaseUrl) {
        throw new Error(
          "CONTEXTENGINE_DATABASE_URL is required (PostgreSQL with pgvector).",
        );
      }
      this.storeOpening = PostgresStore.open({
        databaseUrl: this.config.databaseUrl,
        workspaceId: this.config.workspaceId ?? this.config.root,
      })
        .then((store) => {
          this.store = store;
          return store;
        })
        .finally(() => {
          this.storeOpening = null;
        });
    }
    return this.storeOpening;
  }

  private async ensureSearcher(): Promise<PostgresHybridSearcher> {
    if (!this.searcher) {
      await this.reloadSearcher();
    }
    return this.searcher!;
  }

  /** Refresh cached readers when another process promotes a generation. */
  private async ensureCurrentReader(): Promise<void> {
    const store = await this.ensureStore();
    if (!(await store.isCurrentGeneration())) await this.refresh();
  }

  private async reloadSearcher(): Promise<void> {
    const store = await this.ensureStore();
    const embedder = createEmbeddingProvider(this.config.embeddings);
    const stats = await store.stats(this.config.root);
    this.indexFreshness = {
      indexedAt: stats.lastIndexedAt ?? undefined,
      indexVersion: Number.isFinite(stats.indexVersion)
        ? stats.indexVersion
        : undefined,
      generationId: stats.generationId ?? undefined,
      sourceRevision: stats.sourceRevision ?? undefined,
      indexedRevision: stats.indexedRevision ?? undefined,
      pendingRevision: stats.pendingRevision ?? undefined,
    };
    const searcher = new PostgresHybridSearcher();
    searcher.load({
      embedder,
      store,
      hasEmbeddings: stats.hasEmbeddings,
      neuralRerank: this.config.neuralRerank ?? null,
    });
    this.searcher = searcher;
  }
}

function readRangeWithinRoot(
  root: string,
  requestedPath: string,
  displayPath: string,
  startLine?: number,
  endLine?: number,
): { path: string; content: string; startLine: number; endLine: number } | null {
  const normalizedRequest = requestedPath.replaceAll("\\", "/");
  if (!normalizedRequest || path.posix.isAbsolute(normalizedRequest)) return null;

  const absoluteRoot = path.resolve(root);
  const candidate = path.resolve(absoluteRoot, normalizedRequest);
  if (!isPathWithin(absoluteRoot, candidate)) return null;

  let canonicalRoot: string;
  let canonicalCandidate: string;
  try {
    canonicalRoot = realpathSync.native(absoluteRoot);
    canonicalCandidate = realpathSync.native(candidate);
  } catch {
    return null;
  }
  if (!isPathWithin(canonicalRoot, canonicalCandidate)) return null;

  const text = readTextFile(canonicalCandidate);
  if (text === null) return null;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const s = Math.max(1, startLine ?? 1);
  const e = Math.min(lines.length, endLine ?? lines.length);
  const slice = lines.slice(s - 1, e).join("\n");
  return { path: displayPath, content: slice, startLine: s, endLine: e };
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

const TOKEN_CHARS = 4;
const DUPLICATE_LINE_OVERLAP = 0.8;

interface IndexFreshness {
  indexedAt?: string;
  indexVersion?: number;
  generationId?: string;
  sourceRevision?: string;
  indexedRevision?: string;
  pendingRevision?: string;
}

interface FormattedHit {
  text: string;
  truncated: boolean;
  /**
   * True when the passage was reduced by dropping only unrelated lines
   * (extractive elision) so every query-salient line survives. Such a block is
   * safe to follow with more passages; a hard mid-content cut is not.
   */
  elided?: boolean;
}

/**
 * Arrange passages hierarchically: rank files by their strongest hit, then
 * walk each file in rounds so a second passage can add evidence without
 * allowing one large file to crowd out every other file. Near-identical or
 * overlapping passages are removed before packing.
 */
function orderContextHits(hits: SearchHit[]): SearchHit[] {
  const groups = new Map<
    string,
    { firstIndex: number; hits: Array<{ hit: SearchHit; index: number }> }
  >();
  hits.forEach((hit, index) => {
    const group = groups.get(hit.chunk.path) ?? { firstIndex: index, hits: [] };
    group.hits.push({ hit, index });
    groups.set(hit.chunk.path, group);
  });

  const rankedGroups = [...groups.values()]
    .map((group) => {
      const ranked = [...group.hits].sort(compareHitRank);
      const unique: Array<{ hit: SearchHit; index: number }> = [];
      for (const candidate of ranked) {
        if (
          unique.some((selected) =>
            isRepeatedPassage(selected.hit, candidate.hit),
          )
        ) {
          continue;
        }
        unique.push(candidate);
      }
      return {
        firstIndex: group.firstIndex,
        hits: unique,
        bestScore: unique.length ? unique[0].hit.score : -Infinity,
      };
    })
    .filter((group) => group.hits.length > 0)
    .sort(
      (a, b) =>
        compareNumbers(b.bestScore, a.bestScore) ||
        a.firstIndex - b.firstIndex,
    );

  const ordered: SearchHit[] = [];
  for (let round = 0; ; round++) {
    let added = false;
    for (const group of rankedGroups) {
      const candidate = group.hits[round];
      if (!candidate) continue;
      ordered.push(candidate.hit);
      added = true;
    }
    if (!added) break;
  }
  return ordered;
}

function compareHitRank(
  a: { hit: SearchHit; index: number },
  b: { hit: SearchHit; index: number },
): number {
  return compareNumbers(b.hit.score, a.hit.score) || a.index - b.index;
}

function compareNumbers(a: number, b: number): number {
  const left = Number.isFinite(a) ? a : -Infinity;
  const right = Number.isFinite(b) ? b : -Infinity;
  return left === right ? 0 : left > right ? 1 : -1;
}

function isRepeatedPassage(selected: SearchHit, candidate: SearchHit): boolean {
  const a = selected.chunk;
  const b = candidate.chunk;
  if (a.id === b.id || a.hash === b.hash) return true;
  if (a.startLine === b.startLine && a.endLine === b.endLine) return true;

  const aStart = Math.min(a.startLine, a.endLine);
  const aEnd = Math.max(a.startLine, a.endLine);
  const bStart = Math.min(b.startLine, b.endLine);
  const bEnd = Math.max(b.startLine, b.endLine);
  const overlap = Math.max(
    0,
    Math.min(aEnd, bEnd) - Math.max(aStart, bStart) + 1,
  );
  const shortest = Math.max(
    1,
    Math.min(aEnd - aStart + 1, bEnd - bStart + 1),
  );
  if (overlap / shortest >= DUPLICATE_LINE_OVERLAP) return true;

  const aText = normalizePassage(a.content);
  const bText = normalizePassage(b.content);
  if (aText.length >= 80 && bText.length >= 80) {
    if (aText.includes(bText) || bText.includes(aText)) return true;
  }
  return false;
}

function normalizePassage(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeTokenBudget(value: number | undefined): number | undefined {
  if (value === undefined || value === Number.POSITIVE_INFINITY) {
    return undefined;
  }
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function fitTextToCharBudget(text: string, maxChars: number | undefined): string {
  if (maxChars === undefined || text.length <= maxChars) return text;
  if (maxChars <= 0) return "";
  return text.slice(0, maxChars);
}

function formatHitWithinChars(
  hit: SearchHit,
  freshness: IndexFreshness | undefined,
  maxChars: number | undefined,
  salientTerms: Set<string> | null = null,
): FormattedHit | null {
  const full = formatHit(hit, freshness);
  if (maxChars === undefined || full.length <= maxChars) {
    return { text: full, truncated: false };
  }
  if (maxChars <= 0) return null;

  const content = hit.chunk.content;
  const minimal = formatHit(hit, freshness, "", true);
  if (minimal.length > maxChars) {
    const provenanceOnly = formatProvenanceOnly(hit, freshness);
    if (provenanceOnly.length > maxChars) return null;
    return { text: provenanceOnly, truncated: true };
  }

  // Extractive: keep query-salient lines instead of the leading characters,
  // so the surviving budget carries more task-relevant evidence. Falls back to
  // the leading-character fit when it cannot do better.
  if (salientTerms && salientTerms.size > 0) {
    const extractive = extractSalientContent(content, salientTerms);
    if (extractive && extractive !== content) {
      const candidate = formatHit(hit, freshness, extractive, true);
      // A clean elision keeps every salient line, so packing can continue with
      // more passages instead of stopping at the first reduced block.
      if (candidate.length <= maxChars) {
        return { text: candidate, truncated: true, elided: true };
      }
    }
  }

  let best = minimal;
  let low = 0;
  let high = content.length;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = formatHit(
      hit,
      freshness,
      content.slice(0, middle),
      true,
    );
    if (candidate.length <= maxChars) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return { text: best, truncated: true };
}

/**
 * Salient identifiers/terms from the query, used by the extractive packing
 * policy to decide which lines of a passage carry task-relevant signal.
 */
function buildSalientTerms(analyzed: {
  identifiers: string[];
  tokens: string[];
  expandedTerms: string[];
}): Set<string> {
  const terms = new Set<string>();
  for (const group of [
    analyzed.identifiers,
    analyzed.tokens,
    analyzed.expandedTerms,
  ]) {
    for (const term of group) {
      const normalized = term.trim().toLowerCase();
      if (normalized.length >= 3) terms.add(normalized);
    }
  }
  return terms;
}

/**
 * Reduce a passage to the lines that match query terms plus one line of
 * surrounding context, joining non-adjacent kept regions with an elision
 * marker. Returns null when nothing matches so the caller can fall back to a
 * leading-character fit.
 */
function extractSalientContent(
  content: string,
  salientTerms: Set<string>,
): string | null {
  const lines = content.split("\n");
  if (lines.length <= 3) return null;

  const matched = lines.map((line) => {
    const lower = line.toLowerCase();
    for (const term of salientTerms) {
      if (lower.includes(term)) return true;
    }
    return false;
  });
  if (!matched.some(Boolean)) return null;

  // Keep matched lines plus one line of context on each side.
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (!matched[i]) continue;
    for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 1); j++) {
      keep[j] = true;
    }
  }
  if (keep.every(Boolean)) return null;

  const out: string[] = [];
  let elided = false;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      out.push(lines[i]);
      elided = false;
    } else if (!elided) {
      out.push("… [unrelated lines omitted]");
      elided = true;
    }
  }
  return out.join("\n");
}

function formatProvenanceOnly(
  hit: SearchHit,
  freshness: IndexFreshness | undefined,
): string {
  return [
    `## ${hit.chunk.path}:${hit.chunk.startLine}-${hit.chunk.endLine}`,
    `provenance: ${provenanceJson(hit, freshness)}`,
  ].join("\n");
}

function formatHit(
  hit: SearchHit,
  freshness: IndexFreshness | undefined,
  content = hit.chunk.content,
  contentTruncated = false,
): string {
  const { chunk, score, source, channels, intent } = hit;
  const ch = channels
    ? Object.entries(channels)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${(v as number).toFixed(3)}`)
        .join(" ")
    : "";
  const body = contentTruncated
    ? `${content}${content ? "\n" : ""}… [content truncated to token budget]`
    : content;
  return [
    `## ${chunk.path}:${chunk.startLine}-${chunk.endLine}`,
    `provenance: ${provenanceJson(hit, freshness)}`,
    chunk.symbol ? `symbol: ${chunk.symbol}` : null,
    `lang: ${chunk.language} · score: ${score.toFixed(4)} · via: ${source}${intent ? ` · intent: ${intent}` : ""}${ch ? ` · ${ch}` : ""}`,
    "```" + (chunk.language === "tsx" ? "tsx" : chunk.language),
    body,
    "```",
    "",
  ]
    .filter(Boolean)
    .join("\n");
}

function provenanceJson(
  hit: SearchHit,
  freshness: IndexFreshness | undefined,
): string {
  const provenance: {
    path: string;
    lines: { start: number; end: number };
    hash: string;
    indexed_at?: string;
    index_version?: number;
    generation_id?: string;
    source_revision?: string;
    indexed_revision?: string;
    pending_revision?: string;
  } = {
    path: hit.chunk.path,
    lines: { start: hit.chunk.startLine, end: hit.chunk.endLine },
    hash: hit.chunk.hash,
  };
  if (freshness?.indexedAt) provenance.indexed_at = freshness.indexedAt;
  if (freshness?.indexVersion !== undefined) {
    provenance.index_version = freshness.indexVersion;
  }
  if (freshness?.generationId) {
    provenance.generation_id = freshness.generationId;
  }
  if (freshness?.sourceRevision) {
    provenance.source_revision = freshness.sourceRevision;
  }
  if (freshness?.indexedRevision) {
    provenance.indexed_revision = freshness.indexedRevision;
  }
  if (freshness?.pendingRevision) {
    provenance.pending_revision = freshness.pendingRevision;
  }
  return JSON.stringify(provenance);
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
