import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { ensureDir } from "../util/fs.js";

/**
 * Copy the SQLite index to a portable path for team sharing / backup.
 * Does not include source code — only the derived index.
 */
export function exportIndex(dbPath: string, destPath: string): { ok: true; dest: string } {
  if (!existsSync(dbPath)) {
    throw new Error(`Index not found: ${dbPath}`);
  }
  const dest = path.resolve(destPath);
  ensureDir(path.dirname(dest));
  copyFileSync(dbPath, dest);
  // Also copy WAL/SHM if present for a consistent snapshot after checkpoint ideally
  for (const suffix of ["-wal", "-shm"]) {
    const side = dbPath + suffix;
    if (existsSync(side)) {
      copyFileSync(side, dest + suffix);
    }
  }
  return { ok: true, dest };
}

/**
 * Install a shared index into a workspace data directory.
 */
export function importIndex(
  sourceDbPath: string,
  dataDir: string,
): { ok: true; dest: string } {
  if (!existsSync(sourceDbPath)) {
    throw new Error(`Source index not found: ${sourceDbPath}`);
  }
  mkdirSync(dataDir, { recursive: true });
  const dest = path.join(dataDir, "index.db");
  copyFileSync(sourceDbPath, dest);
  for (const suffix of ["-wal", "-shm"]) {
    const side = sourceDbPath + suffix;
    if (existsSync(side)) {
      copyFileSync(side, dest + suffix);
    }
  }
  return { ok: true, dest };
}
