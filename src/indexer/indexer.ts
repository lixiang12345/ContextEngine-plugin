import { statSync } from "node:fs";
import path from "node:path";
import type { EngineConfig, IndexProgress } from "../types.js";
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
}

export async function indexWorkspace(
  config: EngineConfig,
  onProgress?: (p: IndexProgress) => void,
): Promise<IndexResult> {
  const started = Date.now();
  const store = new SqliteStore(dbPathFor(config.dataDir));
  store.setMeta("root", config.root);

  const files = walkSourceFiles(config.root, config.maxFileBytes);
  onProgress?.({
    phase: "scan",
    filesTotal: files.length,
    filesDone: 0,
    chunksTotal: 0,
    message: `Found ${files.length} candidate files`,
  });

  const livePaths = new Set(files.map((f) => f.relPath));
  let filesRemoved = 0;
  for (const existing of store.listFilePaths()) {
    if (!livePaths.has(existing)) {
      store.deleteFile(existing);
      filesRemoved++;
    }
  }

  let filesIndexed = 0;
  let chunksWritten = 0;
  let filesDone = 0;

  for (const file of files) {
    filesDone++;
    const content = readTextFile(file.absPath);
    if (content === null) continue;

    const fileHash = sha256(content);
    if (store.getFileHash(file.relPath) === fileHash) {
      onProgress?.({
        phase: "chunk",
        filesTotal: files.length,
        filesDone,
        chunksTotal: chunksWritten,
      });
      continue;
    }

    const chunks = chunkFile(file.relPath, content, config.maxChunkChars);
    let mtimeMs = Date.now();
    try {
      mtimeMs = statSync(file.absPath).mtimeMs;
    } catch {
      // ignore
    }

    store.transaction(() => {
      store.upsertFile({
        path: file.relPath,
        hash: fileHash,
        language: languageForPath(file.relPath),
        mtimeMs,
        size: file.size,
      });
      store.replaceChunksForFile(file.relPath, chunks);
    });

    filesIndexed++;
    chunksWritten += chunks.length;
    onProgress?.({
      phase: "chunk",
      filesTotal: files.length,
      filesDone,
      chunksTotal: chunksWritten,
      message: file.relPath,
    });
  }

  // Commit lineage: index recent git history as searchable pseudo-chunks
  const commitLimit = Number(process.env.CONTEXTENGINE_COMMIT_LIMIT ?? 80);
  if (commitLimit > 0) {
    onProgress?.({
      phase: "write",
      filesTotal: files.length,
      filesDone: files.length,
      chunksTotal: chunksWritten,
      message: "Indexing commit lineage…",
    });
    const commits = harvestCommits(config.root, commitLimit);
    const commitChunks = commitsToChunks(commits);
    store.transaction(() => {
      // Remove previous synthetic commit file entries
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
        });
        store.replaceChunksForFile(chunk.path, [chunk]);
        chunksWritten++;
      }
    });
  }

  let embeddingsWritten = 0;
  const embedder = createEmbeddingProvider(config.embeddings);
  if (embedder) {
    embeddingsWritten = await embedMissing(store, embedder, onProgress, files.length);
  }

  store.setMeta("last_indexed_at", new Date().toISOString());
  if (embedder) store.setMeta("embedding_model", embedder.model);
  store.close();

  onProgress?.({
    phase: "done",
    filesTotal: files.length,
    filesDone: files.length,
    chunksTotal: chunksWritten,
    message: "Index complete",
  });

  return {
    filesScanned: files.length,
    filesIndexed,
    filesRemoved,
    chunksWritten,
    embeddingsWritten,
    durationMs: Date.now() - started,
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
