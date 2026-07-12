import { statSync, existsSync } from "node:fs";
import path from "node:path";
import type { EngineConfig, IndexProgress, IndexRoot } from "../types.js";
import { chunkFile } from "../chunker/code-chunker.js";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
} from "../embeddings/provider.js";
import { dbPathFor } from "../config.js";
import { SqliteStore } from "../store/sqlite-store.js";
import {
  languageForPath,
  readTextFile,
  walkSourceFiles,
} from "../util/fs.js";
import { sha256 } from "../util/hash.js";
import { commitsToChunks, harvestCommits } from "../lineage/commits.js";

export interface IndexResult {
  filesScanned: number;
  filesIndexed: number;
  filesRemoved: number;
  chunksWritten: number;
  embeddingsWritten: number;
  durationMs: number;
  roots: string[];
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
  const store = new SqliteStore(dbPathFor(config.dataDir));
  store.setMeta("root", config.root);
  if (config.extraRoots?.length) {
    store.setMeta("extra_roots", JSON.stringify(config.extraRoots));
  }

  const roots = resolveRoots(config);
  store.setMeta(
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

  const jobs: FileJob[] = [];
  for (const root of roots) {
    const files = walkSourceFiles(root.absPath, config.maxFileBytes);
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
  for (const p of store.listFilePaths()) {
    if (p.startsWith(".git/commits/")) livePaths.add(p);
  }

  let filesRemoved = 0;
  for (const existing of store.listFilePaths()) {
    if (!livePaths.has(existing) && !existing.startsWith(".git/commits/")) {
      store.deleteFile(existing);
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
    if (store.getFileHash(job.indexRel) === fileHash) {
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

    store.transaction(() => {
      store.upsertFile({
        path: job.indexRel,
        hash: fileHash,
        language: languageForPath(job.relPath),
        mtimeMs,
        size: job.size,
        rootAlias: job.root.name,
      });
      store.replaceChunksForFile(job.indexRel, chunks, job.root.name);
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

  // Commit lineage from primary root only
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
    const commitChunks = commitsToChunks(commits);
    store.transaction(() => {
      for (const p of store.listFilePaths()) {
        if (p.startsWith(".git/commits/")) store.deleteFile(p);
      }
      for (const chunk of commitChunks) {
        store.upsertFile({
          path: chunk.path,
          hash: chunk.hash,
          language: "git-commit",
          mtimeMs: Date.now(),
          size: chunk.content.length,
          rootAlias: "main",
        });
        store.replaceChunksForFile(chunk.path, [chunk], "main");
        chunksWritten++;
      }
    });
  }

  let embeddingsWritten = 0;
  const embedder = createEmbeddingProvider(config.embeddings);
  if (embedder) {
    embeddingsWritten = await embedMissing(
      store,
      embedder,
      onProgress,
      jobs.length,
    );
  }

  store.setMeta("last_indexed_at", new Date().toISOString());
  if (embedder) store.setMeta("embedding_model", embedder.model);
  store.close();

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

async function embedMissing(
  store: SqliteStore,
  embedder: EmbeddingProvider,
  onProgress: ((p: IndexProgress) => void) | undefined,
  filesTotal: number,
): Promise<number> {
  const missing = store.chunksMissingEmbeddings(embedder.model);
  if (missing.length === 0) return 0;

  let written = 0;
  const batchSize = 32;
  for (let i = 0; i < missing.length; i += batchSize) {
    const batch = missing.slice(i, i + batchSize);
    const texts = batch.map(
      (c) =>
        `File: ${c.path}\nSymbol: ${c.symbol ?? ""}\n\n${c.content.slice(0, 6000)}`,
    );
    onProgress?.({
      phase: "embed",
      filesTotal,
      filesDone: filesTotal,
      chunksTotal: missing.length,
      message: `Embedding ${i + 1}-${Math.min(i + batchSize, missing.length)} / ${missing.length}`,
    });
    const vectors = await embedder.embed(texts);
    store.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        store.upsertEmbedding(batch[j].id, embedder.model, vectors[j]);
        written++;
      }
    });
  }
  return written;
}

export function resolveDataDir(root: string, dataDir?: string): string {
  return path.resolve(dataDir ?? path.join(root, ".contextengine"));
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
