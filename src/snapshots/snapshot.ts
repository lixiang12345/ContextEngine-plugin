import { createHash, randomUUID } from "node:crypto";
import { createGunzip, createGzip } from "node:zlib";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, Readable } from "node:stream";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { z } from "zod";
import { INDEX_VERSION, PostgresStore } from "../store/postgres-store.js";
import type { CodeChunk } from "../types.js";
import type { SnapshotObjectStore } from "./object-store.js";
import { validateSnapshotObjectKey } from "./object-store.js";

export const SNAPSHOT_FORMAT_VERSION = 1;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const PAGE_SIZE = 500;
const PUBLICATION_MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const snapshotNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
const manifestSchema = z
  .object({
    format_version: z.literal(SNAPSHOT_FORMAT_VERSION),
    index_version: z.number().int().positive(),
    created_at: z.string().datetime(),
    workspace_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    generation_id: z.string().min(1).max(512),
    source_revision: z.string().max(2_000).nullable(),
    indexed_revision: z.string().max(2_000).nullable(),
    artifact: z
      .object({
        key: z.string().min(1).max(1_024),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        bytes: z.number().int().nonnegative().max(MAX_ARCHIVE_BYTES),
        content_encoding: z.literal("gzip"),
      })
      .strict(),
    counts: z
      .object({
        metadata: z.number().int().nonnegative().max(1),
        files: z.number().int().nonnegative().max(10_000_000),
        chunks: z.number().int().nonnegative().max(50_000_000),
        embeddings: z.number().int().nonnegative().max(50_000_000),
      })
      .strict(),
  })
  .strict();

export type SnapshotManifest = z.infer<typeof manifestSchema>;

export interface SnapshotExportResult {
  manifest: SnapshotManifest;
  manifestKey: string;
}

export interface SnapshotImportResult {
  manifest: SnapshotManifest;
  generationId: string;
}

export class SnapshotNotFoundError extends Error {
  constructor(readonly key: string) {
    super(`Snapshot object not found: ${key}`);
    this.name = "SnapshotNotFoundError";
  }
}

export async function listIndexSnapshots(
  store: SnapshotObjectStore,
): Promise<string[]> {
  if (!store.list)
    throw new Error("Snapshot object store does not support listing");
  const names = new Set<string>();
  for (const key of await store.list("snapshots")) {
    const match =
      /^snapshots\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/manifest\.json$/.exec(
        key,
      );
    if (match) names.add(match[1]);
  }
  return [...names].sort();
}

export async function deleteIndexSnapshot(options: {
  name: string;
  store: SnapshotObjectStore;
}): Promise<void> {
  const name = snapshotNameSchema.parse(options.name);
  await options.store.delete(`snapshots/${name}/manifest.json`);
}

/** Remove unreferenced content-addressed artifacts after snapshot deletion. */
export async function garbageCollectSnapshotArtifacts(
  store: SnapshotObjectStore,
): Promise<string[]> {
  if (!store.list)
    throw new Error("Snapshot object store does not support listing");
  for (const key of await store.list("operations")) {
    if (!/^operations\/publish-[0-9a-f-]{36}\.json$/.test(key)) continue;
    const marker = z
      .object({ created_at: z.string().datetime() })
      .strict()
      .parse(JSON.parse(await readObject(store, key, MAX_MANIFEST_BYTES)));
    if (
      Date.now() - Date.parse(marker.created_at) <=
      PUBLICATION_MARKER_TTL_MS
    ) {
      throw new Error(
        "Cannot garbage collect while a snapshot publication is active",
      );
    }
    await store.delete(key);
  }
  const referenced = new Set<string>();
  for (const name of await listIndexSnapshots(store)) {
    try {
      const manifest = manifestSchema.parse(
        JSON.parse(
          await readObject(
            store,
            `snapshots/${name}/manifest.json`,
            MAX_MANIFEST_BYTES,
          ),
        ),
      );
      referenced.add(manifest.artifact.key);
    } catch (error) {
      throw new Error(
        `Cannot garbage collect while snapshot ${name} has an invalid manifest`,
        {
          cause: error,
        },
      );
    }
  }
  const deleted: string[] = [];
  for (const key of await store.list("objects/sha256")) {
    if (!/^objects\/sha256\/[0-9a-f]{64}\.ndjson\.gz$/.test(key)) continue;
    if (!referenced.has(key)) {
      await store.delete(key);
      deleted.push(key);
    }
  }
  return deleted.sort();
}

export async function pruneIndexSnapshots(options: {
  store: SnapshotObjectStore;
  keepLatest?: number;
  olderThanMs?: number;
}): Promise<string[]> {
  const keepLatest = options.keepLatest ?? 0;
  if (!Number.isInteger(keepLatest) || keepLatest < 0 || keepLatest > 10_000) {
    throw new Error("Snapshot keepLatest must be an integer from 0 to 10000");
  }
  if (options.olderThanMs === undefined && keepLatest === 0) {
    throw new Error("Snapshot prune requires keepLatest or olderThanMs");
  }
  if (
    options.olderThanMs !== undefined &&
    (!Number.isFinite(options.olderThanMs) || options.olderThanMs < 0)
  ) {
    throw new Error("Snapshot olderThanMs must be non-negative");
  }
  if (!options.store.list)
    throw new Error("Snapshot object store does not support listing");
  const manifests = await Promise.all(
    (await listIndexSnapshots(options.store)).map(async (name) => ({
      name,
      manifest: manifestSchema.parse(
        JSON.parse(
          await readObject(
            options.store,
            `snapshots/${name}/manifest.json`,
            MAX_MANIFEST_BYTES,
          ),
        ),
      ),
    })),
  );
  manifests.sort((left, right) =>
    right.manifest.created_at.localeCompare(left.manifest.created_at),
  );
  const cutoff =
    options.olderThanMs === undefined ? null : Date.now() - options.olderThanMs;
  const deleted: string[] = [];
  for (let index = 0; index < manifests.length; index++) {
    const entry = manifests[index];
    const beyondKeep = index >= keepLatest;
    const beyondAge =
      cutoff === null || Date.parse(entry.manifest.created_at) <= cutoff;
    if (beyondKeep && beyondAge) {
      await deleteIndexSnapshot({ name: entry.name, store: options.store });
      deleted.push(entry.name);
    }
  }
  return deleted.sort();
}

export async function exportIndexSnapshot(options: {
  databaseUrl: string;
  workspaceId: string;
  name: string;
  store: SnapshotObjectStore;
}): Promise<SnapshotExportResult> {
  const name = snapshotNameSchema.parse(options.name);
  const reader = await PostgresStore.open({
    databaseUrl: options.databaseUrl,
    workspaceId: options.workspaceId,
  });
  const temporary = path.join(
    os.tmpdir(),
    `contextengine-snapshot-${randomUUID()}.ndjson.gz`,
  );
  let publicationMarkerKey: string | null = null;
  try {
    const status = await reader.generationStatus();
    if (!status.generationId)
      throw new Error(
        "Cannot snapshot a workspace without an active generation",
      );
    const counts = { metadata: 0, files: 0, chunks: 0, embeddings: 0 };
    const hash = createHash("sha256");
    let bytes = 0;
    const digest = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        bytes += chunk.byteLength;
        if (bytes > MAX_ARCHIVE_BYTES) {
          callback(
            new Error("Index snapshot exceeds the 4 GiB compressed size limit"),
          );
          return;
        }
        callback(null, chunk);
      },
    });
    const gzip = createGzip({ level: 6 });
    await mkdir(path.dirname(temporary), { recursive: true });
    const output = pipeline(
      gzip,
      digest,
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
    try {
      await reader.consistentRead(async (snapshot) => {
        await writeLine(gzip, {
          type: "header",
          format_version: SNAPSHOT_FORMAT_VERSION,
          index_version: INDEX_VERSION,
          workspace_fingerprint: createHash("sha256")
            .update(snapshot.logicalWorkspaceId)
            .digest("hex"),
          generation_id: status.generationId,
          source_revision: status.sourceRevision,
          indexed_revision: status.indexedRevision,
        });
        const metadata = await snapshot.snapshotMetadata();
        await writeLine(gzip, { type: "metadata", value: metadata });
        counts.metadata = 1;

        let afterPath: string | null = null;
        for (;;) {
          const page = await snapshot.snapshotFilesPage(afterPath, PAGE_SIZE);
          for (const row of page)
            await writeLine(gzip, { type: "file", value: row });
          counts.files += page.length;
          if (page.length < PAGE_SIZE) break;
          afterPath = page[page.length - 1].path;
        }

        let afterChunk: { path: string; id: string } | null = null;
        for (;;) {
          const page = await snapshot.snapshotChunksPage(afterChunk, PAGE_SIZE);
          for (const row of page)
            await writeLine(gzip, { type: "chunk", value: row });
          counts.chunks += page.length;
          if (page.length < PAGE_SIZE) break;
          const last = page[page.length - 1];
          afterChunk = { path: last.path, id: last.id };
        }

        let afterEmbedding: string | null = null;
        for (;;) {
          const page = await snapshot.snapshotEmbeddingsPage(
            afterEmbedding,
            PAGE_SIZE,
          );
          for (const row of page)
            await writeLine(gzip, { type: "embedding", value: row });
          counts.embeddings += page.length;
          if (page.length < PAGE_SIZE) break;
          afterEmbedding = page[page.length - 1].chunkId;
        }
      });
      gzip.end();
      await output;
    } catch (error) {
      gzip.destroy(error instanceof Error ? error : new Error(String(error)));
      await output.catch(() => undefined);
      throw error;
    }
    const digestHex = hash.digest("hex");
    const file = await stat(temporary);
    if (file.size !== bytes)
      throw new Error("Snapshot artifact size accounting failed");
    const artifactKey = `objects/sha256/${digestHex}.ndjson.gz`;
    publicationMarkerKey = `operations/publish-${randomUUID()}.json`;
    const markerBody = JSON.stringify({ created_at: new Date().toISOString() });
    await options.store.put(publicationMarkerKey, Readable.from([markerBody]), {
      contentType: "application/json",
      contentLength: Buffer.byteLength(markerBody),
    });
    await options.store.put(artifactKey, createReadStream(temporary), {
      contentType: "application/x-ndjson",
      contentEncoding: "gzip",
      contentLength: bytes,
      checksumSha256: digestHex,
    });
    const manifest: SnapshotManifest = {
      format_version: SNAPSHOT_FORMAT_VERSION,
      index_version: INDEX_VERSION,
      created_at: new Date().toISOString(),
      workspace_fingerprint: createHash("sha256")
        .update(reader.logicalWorkspaceId)
        .digest("hex"),
      generation_id: status.generationId,
      source_revision: status.sourceRevision,
      indexed_revision: status.indexedRevision,
      artifact: {
        key: artifactKey,
        sha256: digestHex,
        bytes,
        content_encoding: "gzip",
      },
      counts,
    };
    const manifestKey = `snapshots/${name}/manifest.json`;
    await options.store.put(
      manifestKey,
      Readable.from([JSON.stringify(manifest)]),
      {
        contentType: "application/json",
        contentLength: Buffer.byteLength(JSON.stringify(manifest)),
      },
    );
    return { manifest, manifestKey };
  } finally {
    if (publicationMarkerKey) {
      try {
        await options.store.delete(publicationMarkerKey);
      } catch {
        // A stale marker fails GC closed and expires after the bounded TTL.
      }
    }
    await reader.close();
    await rm(temporary, { force: true });
  }
}

export async function importIndexSnapshot(options: {
  databaseUrl: string;
  workspaceId: string;
  name: string;
  store: SnapshotObjectStore;
}): Promise<SnapshotImportResult> {
  const name = snapshotNameSchema.parse(options.name);
  const manifestKey = `snapshots/${name}/manifest.json`;
  const manifest = manifestSchema.parse(
    JSON.parse(
      await readObject(options.store, manifestKey, MAX_MANIFEST_BYTES),
    ),
  );
  if (manifest.index_version !== INDEX_VERSION) {
    throw new Error(
      `Snapshot index version ${manifest.index_version} is incompatible with ${INDEX_VERSION}`,
    );
  }
  validateSnapshotObjectKey(manifest.artifact.key);
  if (
    manifest.artifact.key !==
    `objects/sha256/${manifest.artifact.sha256}.ndjson.gz`
  ) {
    throw new Error("Snapshot artifact key does not match its digest");
  }
  const temporary = path.join(
    os.tmpdir(),
    `contextengine-import-${randomUUID()}.ndjson.gz`,
  );
  const reader = await PostgresStore.open({
    databaseUrl: options.databaseUrl,
    workspaceId: options.workspaceId,
    lockWorkspace: true,
  });
  let staging: PostgresStore | null = null;
  try {
    await downloadAndVerify(
      options.store,
      manifest.artifact.key,
      manifest.artifact.sha256,
      manifest.artifact.bytes,
      temporary,
    );
    staging = await reader.beginGeneration(
      manifest.indexed_revision ?? manifest.source_revision,
    );
    await staging.clearWorkspace();
    let metadata: Record<string, string> | null = null;
    let currentPath: string | null = null;
    let currentRoot = "main";
    let chunks: CodeChunk[] = [];
    let files: Array<z.infer<typeof fileSchema>> = [];
    let embeddings: Array<{ chunkId: string; vector: number[] }> = [];
    let embeddingModel: string | null = null;
    const embeddingDimensions = new Set<number>();
    let fileCount = 0;
    let chunkCount = 0;
    let embeddingCount = 0;
    let header: z.infer<typeof headerSchema> | null = null;
    let phase = 0;
    let recordIndex = 0;
    let uncompressedBytes = 0;
    const uncompressedLimit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        uncompressedBytes += chunk.length;
        if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES)
          callback(new Error("Snapshot expands beyond the 64 GiB limit"));
        else callback(null, chunk);
      },
    });
    const input = createInterface({
      input: createReadStream(temporary)
        .pipe(createGunzip())
        .pipe(uncompressedLimit),
    });
    for await (const line of input) {
      if (Buffer.byteLength(line) > MAX_LINE_BYTES)
        throw new Error("Snapshot record exceeds line size limit");
      const record = parseRecord(line);
      if (record.type === "header") {
        if (header || recordIndex !== 0)
          throw new Error("Snapshot header must be the first record");
        header = headerSchema.parse(record);
        recordIndex++;
        continue;
      }
      if (!header) throw new Error("Snapshot header must be the first record");
      if (record.type === "metadata") {
        if (phase > 1)
          throw new Error("Snapshot metadata record is out of order");
        phase = 1;
        if (metadata)
          throw new Error("Snapshot contains duplicate metadata records");
        metadata = metadataSchema.parse(record.value);
      } else if (record.type === "file") {
        if (phase > 2) throw new Error("Snapshot file record is out of order");
        phase = 2;
        const file = fileSchema.parse(record.value);
        files.push(file);
        if (files.length >= PAGE_SIZE) {
          await staging.upsertFiles(files);
          files = [];
        }
        fileCount++;
      } else if (record.type === "chunk") {
        if (phase > 3) throw new Error("Snapshot chunk record is out of order");
        phase = 3;
        if (files.length) {
          await staging.upsertFiles(files);
          files = [];
        }
        const chunk = chunkSchema.parse(record.value);
        if (currentPath !== chunk.path) {
          if (currentPath !== null)
            await staging.replaceChunksForFile(
              currentPath,
              chunks,
              currentRoot,
            );
          currentPath = chunk.path;
          currentRoot = chunk.rootAlias;
          chunks = [];
        }
        chunks.push(chunk);
        chunkCount++;
      } else if (record.type === "embedding") {
        phase = 4;
        if (files.length) {
          await staging.upsertFiles(files);
          files = [];
        }
        if (currentPath !== null) {
          await staging.replaceChunksForFile(currentPath, chunks, currentRoot);
          currentPath = null;
          chunks = [];
        }
        const embedding = embeddingSchema.parse(record.value);
        const vector = parseVector(embedding.embedding, embedding.dim);
        if (embeddingModel !== null && embeddingModel !== embedding.model) {
          await staging.upsertEmbeddings(embeddingModel, embeddings);
          embeddings = [];
        }
        embeddingModel = embedding.model;
        embeddings.push({ chunkId: embedding.chunkId, vector });
        if (embeddings.length >= PAGE_SIZE) {
          await staging.upsertEmbeddings(embeddingModel, embeddings);
          embeddings = [];
        }
        embeddingDimensions.add(embedding.dim);
        embeddingCount++;
      } else {
        throw new Error(
          `Snapshot contains unknown record type: ${record.type}`,
        );
      }
      recordIndex++;
    }
    if (files.length) await staging.upsertFiles(files);
    if (currentPath !== null)
      await staging.replaceChunksForFile(currentPath, chunks, currentRoot);
    if (embeddingModel && embeddings.length)
      await staging.upsertEmbeddings(embeddingModel, embeddings);
    if (
      !header ||
      header.workspace_fingerprint !== manifest.workspace_fingerprint ||
      header.generation_id !== manifest.generation_id ||
      header.source_revision !== manifest.source_revision ||
      header.indexed_revision !== manifest.indexed_revision
    ) {
      throw new Error("Snapshot header does not match manifest");
    }
    if (!metadata) throw new Error("Snapshot is missing metadata");
    for (const [key, value] of Object.entries(metadata))
      await staging.setMeta(key, value);
    await staging.setMeta("root", `snapshot://${name}`);
    await staging.setMeta(
      "roots",
      JSON.stringify([
        { name: "snapshot", path: `snapshot://${name}`, kind: "code" },
      ]),
    );
    await staging.setMeta("source_revision", manifest.source_revision ?? "");
    if (
      manifest.counts.metadata !== 1 ||
      fileCount !== manifest.counts.files ||
      chunkCount !== manifest.counts.chunks ||
      embeddingCount !== manifest.counts.embeddings
    ) {
      throw new Error("Snapshot record counts do not match manifest");
    }
    const storedCounts = await staging.snapshotRowCounts();
    if (
      storedCounts.files !== fileCount ||
      storedCounts.chunks !== chunkCount ||
      storedCounts.embeddings !== embeddingCount ||
      storedCounts.orphanChunks !== 0
    ) {
      throw new Error(
        "Imported snapshot database rows failed integrity checks",
      );
    }
    for (const dimension of embeddingDimensions)
      await staging.ensureVectorIndex(dimension);
    await staging.promoteGeneration();
    const generationId = staging.generationId;
    return { manifest, generationId };
  } catch (error) {
    if (staging) {
      try {
        await staging.discardGeneration();
      } catch {
        /* preserve import failure */
      }
    }
    throw error;
  } finally {
    if (staging) await staging.close();
    else await reader.close();
    await rm(temporary, { force: true });
  }
}

const metadataSchema = z.record(z.string().max(100), z.string().max(10_000));
const headerSchema = z
  .object({
    type: z.literal("header"),
    format_version: z.literal(SNAPSHOT_FORMAT_VERSION),
    index_version: z.literal(INDEX_VERSION),
    workspace_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    generation_id: z.string().min(1).max(512),
    source_revision: z.string().max(2_000).nullable(),
    indexed_revision: z.string().max(2_000).nullable(),
  })
  .strict();
const fileSchema = z
  .object({
    path: z.string().min(1).max(4_096),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    language: z.string().min(1).max(100),
    mtimeMs: z.number().finite(),
    size: z.number().int().nonnegative(),
    rootAlias: z.string().max(200),
  })
  .strict();
const chunkSchema = z
  .object({
    id: z.string().min(1).max(512),
    path: z.string().min(1).max(4_096),
    language: z.string().min(1).max(100),
    startLine: z.number().int().nonnegative(),
    endLine: z.number().int().nonnegative(),
    content: z.string().max(16 * 1024 * 1024),
    symbol: z.string().max(1_000).optional(),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    rootAlias: z.string().max(200),
  })
  .strict();
const embeddingSchema = z
  .object({
    chunkId: z.string().min(1).max(512),
    model: z.string().min(1).max(500),
    dim: z.number().int().positive().max(16_000),
    embedding: z.string().max(400_000),
  })
  .strict();

function parseRecord(line: string): { type: string; value?: unknown } {
  try {
    const record = JSON.parse(line) as { type?: unknown; value?: unknown };
    if (!record || typeof record.type !== "string") throw new Error();
    return record as { type: string; value?: unknown };
  } catch {
    throw new Error("Snapshot contains invalid JSON record");
  }
}

async function writeLine(stream: Transform, value: unknown): Promise<void> {
  const line = `${JSON.stringify(value)}\n`;
  if (!stream.write(line)) await once(stream, "drain");
}

function parseVector(value: string, dim: number): number[] {
  const parsed = value
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map(Number);
  if (parsed.length !== dim || parsed.some((item) => !Number.isFinite(item)))
    throw new Error("Snapshot embedding vector is invalid");
  return parsed;
}

async function readObject(
  store: SnapshotObjectStore,
  key: string,
  maxBytes: number,
): Promise<string> {
  try {
    const stream = await store.get(key);
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) throw new Error("Snapshot manifest is too large");
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    if (isMissingObjectError(error)) throw new SnapshotNotFoundError(key);
    throw error;
  }
}

function isMissingObjectError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return (
    candidate.code === "ENOENT" ||
    candidate.name === "NoSuchKey" ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

async function downloadAndVerify(
  store: SnapshotObjectStore,
  key: string,
  expectedSha256: string,
  expectedBytes: number,
  target: string,
): Promise<void> {
  const source = await store.get(key);
  const hash = createHash("sha256");
  let bytes = 0;
  const digest = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      if (bytes > MAX_ARCHIVE_BYTES)
        callback(new Error("Snapshot artifact exceeds size limit"));
      else callback(null, chunk);
    },
  });
  await pipeline(
    source,
    digest,
    createWriteStream(target, { flags: "wx", mode: 0o600 }),
  );
  if (bytes !== expectedBytes || hash.digest("hex") !== expectedSha256)
    throw new Error("Snapshot artifact checksum or size mismatch");
}
