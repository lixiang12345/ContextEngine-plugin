import { statSync, existsSync } from "node:fs";
import path from "node:path";
import type { EngineConfig, IndexProgress, IndexRoot } from "../types.js";
import { chunkFile } from "../chunker/code-chunker.js";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
} from "../embeddings/provider.js";
import { PostgresStore } from "../store/postgres-store.js";
import {
  languageForPath,
  readTextFile,
  walkSourceFiles,
} from "../util/fs.js";
import { sha256 } from "../util/hash.js";
import { commitsToChunks, harvestCommits } from "../lineage/commits.js";

const EMBEDDING_FORMAT_VERSION = 2;

export interface IndexResult {
  filesScanned: number;
  filesIndexed: number;
  filesRemoved: number;
  chunksWritten: number;
  embeddingsWritten: number;
  durationMs: number;
  roots: string[];
}

/**
 * A source file supplied by a remote HTTP workspace. Content is read from the
 * durable Blob mapping one file at a time, rather than materializing a repo in
 * the server process.
 */
export interface VirtualSourceDocument {
  path: string;
  content: string;
  hash: string;
  language: string;
  mtimeMs: number;
  size: number;
  rootAlias?: string;
}

export interface VirtualIndexOptions {
  filesTotal: number;
  deletedPaths?: string[];
  rebuild?: boolean;
  rootLabel?: string;
  onProgress?: (progress: IndexProgress) => void;
}

interface ResolvedRoot {
  name: string;
  absPath: string;
  /** Prefix for paths in the index when multi-root */
  pathPrefix: string;
  kind: "code" | "docs";
}

function resolveRoots(config: EngineConfig): ResolvedRoot[] {
  const extras = config.extraRoots ?? [];
  const multi = extras.length > 0;
  const roots: ResolvedRoot[] = [
    {
      name: "main",
      absPath: config.root,
      pathPrefix: multi ? "main" : "",
      kind: "code",
    },
  ];
  for (const r of extras) {
    const abs = path.resolve(r.path);
    if (!existsSync(abs)) continue;
    roots.push({
      name: r.name,
      absPath: abs,
      pathPrefix: r.name,
      kind: r.kind ?? "code",
    });
  }
  return roots;
}

function indexPath(root: ResolvedRoot, rel: string): string {
  if (!root.pathPrefix) return rel;
  return `${root.pathPrefix}/${rel}`;
}

export async function indexWorkspace(
  config: EngineConfig,
  onProgress?: (p: IndexProgress) => void,
): Promise<IndexResult> {
  const started = Date.now();
  const store = await PostgresStore.open({
    databaseUrl: requireDatabaseUrl(config),
    workspaceId: config.workspaceId ?? config.root,
  });
  await store.setMeta("root", config.root);
  if (config.extraRoots?.length) {
    await store.setMeta("extra_roots", JSON.stringify(config.extraRoots));
  }

  const roots = resolveRoots(config);
  await store.setMeta(
    "roots",
    JSON.stringify(
      roots.map((r) => ({ name: r.name, path: r.absPath, kind: r.kind })),
    ),
  );

  type FileJob = {
    root: ResolvedRoot;
    absPath: string;
    relPath: string;
    indexRel: string;
    size: number;
  };

  const extraIgnores = [
    ...(config.extraIgnores ?? []),
    ...parseExcludeEnv(),
  ];
  const jobs: FileJob[] = [];
  for (const root of roots) {
    const files = walkSourceFiles(root.absPath, config.maxFileBytes, {
      extraIgnores,
    });
    for (const f of files) {
      jobs.push({
        root,
        absPath: f.absPath,
        relPath: f.relPath,
        indexRel: indexPath(root, f.relPath),
        size: f.size,
      });
    }
  }

  onProgress?.({
    phase: "scan",
    filesTotal: jobs.length,
    filesDone: 0,
    chunksTotal: 0,
    message: `Found ${jobs.length} files across ${roots.length} root(s)`,
  });

  const livePaths = new Set(jobs.map((j) => j.indexRel));
  // Keep synthetic commit paths
  for (const p of await store.listFilePaths()) {
    if (p.startsWith(".git/commits/")) livePaths.add(p);
  }

  let filesRemoved = 0;
  for (const existing of await store.listFilePaths()) {
    if (!livePaths.has(existing) && !existing.startsWith(".git/commits/")) {
      await store.deleteFile(existing);
      filesRemoved++;
    }
  }

  let filesIndexed = 0;
  let chunksWritten = 0;
  let filesDone = 0;

  for (const job of jobs) {
    filesDone++;
    const content = readTextFile(job.absPath);
    if (content === null) continue;

    const fileHash = sha256(content);
    if ((await store.getFileHash(job.indexRel)) === fileHash) {
      onProgress?.({
        phase: "chunk",
        filesTotal: jobs.length,
        filesDone,
        chunksTotal: chunksWritten,
      });
      continue;
    }

    const chunks = chunkFile(job.indexRel, content, config.maxChunkChars);
    let mtimeMs = Date.now();
    try {
      mtimeMs = statSync(job.absPath).mtimeMs;
    } catch {
      // ignore
    }

    await store.transaction(async (tx) => {
      await tx.upsertFile({
        path: job.indexRel,
        hash: fileHash,
        language: languageForPath(job.relPath),
        mtimeMs,
        size: job.size,
        rootAlias: job.root.name,
      });
      await tx.replaceChunksForFile(job.indexRel, chunks, job.root.name);
    });

    filesIndexed++;
    chunksWritten += chunks.length;
    onProgress?.({
      phase: "chunk",
      filesTotal: jobs.length,
      filesDone,
      chunksTotal: chunksWritten,
      message: job.indexRel,
    });
  }

  // Commit lineage from primary root only (skip rewrite when head set unchanged)
  const commitLimit = Number(process.env.CONTEXTENGINE_COMMIT_LIMIT ?? 80);
  if (commitLimit > 0) {
    onProgress?.({
      phase: "write",
      filesTotal: jobs.length,
      filesDone: jobs.length,
      chunksTotal: chunksWritten,
      message: "Indexing commit lineage…",
    });
    const commits = harvestCommits(config.root, commitLimit);
    const lineageKey = commits.map((c) => c.hash).join(",");
    const prevKey = await store.getMeta("commit_lineage_key");
    if (lineageKey !== prevKey) {
      const commitChunks = commitsToChunks(commits);
      await store.transaction(async (tx) => {
        for (const p of await tx.listFilePaths()) {
          if (p.startsWith(".git/commits/")) await tx.deleteFile(p);
        }
        for (const chunk of commitChunks) {
          await tx.upsertFile({
            path: chunk.path,
            hash: chunk.hash,
            language: "git-commit",
            mtimeMs: Date.now(),
            size: chunk.content.length,
            rootAlias: "main",
          });
          await tx.replaceChunksForFile(chunk.path, [chunk], "main");
          chunksWritten++;
        }
      });
      await store.setMeta("commit_lineage_key", lineageKey);
    }
  }

  let embeddingsWritten = 0;
  const embedder = createEmbeddingProvider(config.embeddings);
  if (embedder) {
    const embeddingSignature = JSON.stringify({
      version: EMBEDDING_FORMAT_VERSION,
      model: embedder.model,
      dimensions: config.embeddings?.dimensions ?? null,
      inputType: /^(1|true|yes|on)$/i.test(
        process.env.CONTEXTENGINE_EMBEDDING_INPUT_TYPE?.trim() || "",
      ),
      maxChars: Number(process.env.CONTEXTENGINE_EMBED_MAX_CHARS || 4000),
    });
    const previousSignature = await store.getMeta("embedding_signature");
    // A legacy index without a signature may contain vectors produced with
    // different model/query settings, so rebuild it once rather than mixing.
    if (
      previousSignature !== embeddingSignature &&
      (previousSignature || (await store.embeddingCount()) > 0)
    ) {
      await store.clearEmbeddings();
    }
    const embedded = await embedMissing(
      store,
      embedder,
      onProgress,
      jobs.length,
    );
    embeddingsWritten = embedded.written;
    if (embedded.dimension) await store.ensureVectorIndex(embedded.dimension);
    await store.setMeta("embedding_signature", embeddingSignature);
  }

  await store.setMeta("last_indexed_at", new Date().toISOString());
  if (embedder) await store.setMeta("embedding_model", embedder.model);
  await store.close();

  onProgress?.({
    phase: "done",
    filesTotal: jobs.length,
    filesDone: jobs.length,
    chunksTotal: chunksWritten,
    message: "Index complete",
  });

  return {
    filesScanned: jobs.length,
    filesIndexed,
    filesRemoved,
    chunksWritten,
    embeddingsWritten,
    durationMs: Date.now() - started,
    roots: roots.map((r) => r.absPath),
  };
}

/**
 * Incrementally index documents kept in PostgreSQL Blob storage. This is the
 * HTTP-server counterpart to `indexWorkspace`: it shares chunking, graph and
 * embedding behavior while never reading a caller-controlled local path.
 */
export async function indexVirtualWorkspace(
  config: EngineConfig,
  documents: AsyncIterable<VirtualSourceDocument>,
  options: VirtualIndexOptions,
): Promise<IndexResult> {
  const started = Date.now();
  const workspaceId = config.workspaceId ?? config.root;
  const store = await PostgresStore.open({
    databaseUrl: requireDatabaseUrl(config),
    workspaceId,
  });
  const onProgress = options.onProgress;
  const filesTotal = Math.max(0, options.filesTotal);
  let filesScanned = 0;
  let filesIndexed = 0;
  let filesRemoved = 0;
  let chunksWritten = 0;

  try {
    if (options.rebuild) {
      await store.clearWorkspace();
    }
    await store.setMeta("root", options.rootLabel ?? `remote://${workspaceId}`);
    await store.setMeta(
      "roots",
      JSON.stringify([
        {
          name: "main",
          path: options.rootLabel ?? `remote://${workspaceId}`,
          kind: "code",
        },
      ]),
    );

    onProgress?.({
      phase: "scan",
      filesTotal,
      filesDone: 0,
      chunksTotal: 0,
      message: "Reading synchronized source blobs",
    });

    for (const relPath of options.deletedPaths ?? []) {
      await store.deleteFile(relPath);
      filesRemoved++;
    }

    for await (const document of documents) {
      filesScanned++;
      if (document.size > config.maxFileBytes) continue;
      if ((await store.getFileHash(document.path)) === document.hash) {
        onProgress?.({
          phase: "chunk",
          filesTotal,
          filesDone: filesScanned,
          chunksTotal: chunksWritten,
        });
        continue;
      }

      const chunks = chunkFile(
        document.path,
        document.content,
        config.maxChunkChars,
      );
      await store.transaction(async (tx) => {
        await tx.upsertFile({
          path: document.path,
          hash: document.hash,
          language: document.language,
          mtimeMs: document.mtimeMs,
          size: document.size,
          rootAlias: document.rootAlias ?? "main",
        });
        await tx.replaceChunksForFile(
          document.path,
          chunks,
          document.rootAlias ?? "main",
        );
      });
      filesIndexed++;
      chunksWritten += chunks.length;
      onProgress?.({
        phase: "chunk",
        filesTotal,
        filesDone: filesScanned,
        chunksTotal: chunksWritten,
        message: document.path,
      });
    }

    let embeddingsWritten = 0;
    const embedder = createEmbeddingProvider(config.embeddings);
    if (embedder) {
      const embeddingSignature = JSON.stringify({
        version: EMBEDDING_FORMAT_VERSION,
        model: embedder.model,
        dimensions: config.embeddings?.dimensions ?? null,
        inputType: /^(1|true|yes|on)$/i.test(
          process.env.CONTEXTENGINE_EMBEDDING_INPUT_TYPE?.trim() || "",
        ),
        maxChars: Number(process.env.CONTEXTENGINE_EMBED_MAX_CHARS || 4000),
      });
      const previousSignature = await store.getMeta("embedding_signature");
      if (
        previousSignature !== embeddingSignature &&
        (previousSignature || (await store.embeddingCount()) > 0)
      ) {
        await store.clearEmbeddings();
      }
      const embedded = await embedMissing(store, embedder, onProgress, filesTotal);
      embeddingsWritten = embedded.written;
      if (embedded.dimension) await store.ensureVectorIndex(embedded.dimension);
      await store.setMeta("embedding_signature", embeddingSignature);
      await store.setMeta("embedding_model", embedder.model);
    }

    await store.setMeta("last_indexed_at", new Date().toISOString());
    onProgress?.({
      phase: "done",
      filesTotal,
      filesDone: filesScanned,
      chunksTotal: chunksWritten,
      message: "Index complete",
    });

    return {
      filesScanned,
      filesIndexed,
      filesRemoved,
      chunksWritten,
      embeddingsWritten,
      durationMs: Date.now() - started,
      roots: [options.rootLabel ?? `remote://${workspaceId}`],
    };
  } finally {
    await store.close();
  }
}

async function embedMissing(
  store: PostgresStore,
  embedder: EmbeddingProvider,
  onProgress: ((p: IndexProgress) => void) | undefined,
  filesTotal: number,
): Promise<{ written: number; dimension: number | null }> {
  const total = await store.countChunksMissingEmbeddings(embedder.model);
  if (total === 0) return { written: 0, dimension: null };

  let written = 0;
  let dimension: number | null = null;
  const batchSize = 32;
  for (;;) {
    const batch = await store.chunksMissingEmbeddings(
      embedder.model,
      batchSize,
    );
    if (batch.length === 0) break;
    const texts = batch.map(
      (c) =>
        `File: ${c.path}\nSymbol: ${c.symbol ?? ""}\n\n${c.content.slice(0, 6000)}`,
    );
    onProgress?.({
      phase: "embed",
      filesTotal,
      filesDone: filesTotal,
      chunksTotal: total,
      message: `Embedding ${written + 1}-${written + batch.length} / ${total}`,
    });
    const vectors = await embedder.embed(texts);
    if (vectors[0]) dimension = vectors[0].length;
    await store.transaction(async (tx) => {
      for (let j = 0; j < batch.length; j++) {
        await tx.upsertEmbedding(batch[j].id, embedder.model, vectors[j]);
        written++;
      }
    });
  }
  return { written, dimension };
}

function requireDatabaseUrl(config: EngineConfig): string {
  if (config.databaseUrl) return config.databaseUrl;
  throw new Error(
    "CONTEXTENGINE_DATABASE_URL is required (PostgreSQL with pgvector).",
  );
}

export function parseExtraRootsFromEnv(): IndexRoot[] {
  // CONTEXTENGINE_EXTRA_ROOTS=docs:/path/to/docs,api:/path/to/api
  const raw = process.env.CONTEXTENGINE_EXTRA_ROOTS;
  if (!raw) return [];
  const out: IndexRoot[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue;
    const name = trimmed.slice(0, colon).trim();
    const p = trimmed.slice(colon + 1).trim();
    if (name && p) {
      out.push({
        name,
        path: p,
        kind: name.includes("doc") ? "docs" : "code",
      });
    }
  }
  return out;
}

/** CONTEXTENGINE_EXCLUDE=vendor/,*.generated.ts,tmp/** */
export function parseExcludeEnv(): string[] {
  const raw = process.env.CONTEXTENGINE_EXCLUDE ?? "";
  if (!raw.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
