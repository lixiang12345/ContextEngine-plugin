import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { resolveEngineConfig } from "../config.js";
import type { EngineConfig } from "../types.js";

export interface RepoProfile {
  name: string;
  root: string;
  dataDir?: string;
}

export interface MultiRepoConfig {
  version: 1;
  profiles: RepoProfile[];
  /** Default profile name */
  default?: string;
}

const CONFIG_NAME = "contextengine.profiles.json";

export function defaultProfilesPath(cwd = process.cwd()): string {
  return path.join(cwd, CONFIG_NAME);
}

export function loadProfiles(filePath?: string): MultiRepoConfig {
  const p = filePath ?? defaultProfilesPath();
  if (!existsSync(p)) {
    return { version: 1, profiles: [] };
  }
  const raw = JSON.parse(readFileSync(p, "utf8")) as MultiRepoConfig;
  if (!raw.profiles) raw.profiles = [];
  raw.version = 1;
  return raw;
}

export function saveProfiles(config: MultiRepoConfig, filePath?: string): void {
  const p = filePath ?? defaultProfilesPath();
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(config, null, 2) + "\n", "utf8");
}

export function resolveProfile(
  name: string | undefined,
  filePath?: string,
): EngineConfig {
  const cfg = loadProfiles(filePath);
  if (!cfg.profiles.length) {
    return resolveEngineConfig({});
  }
  const key = name || cfg.default || cfg.profiles[0].name;
  const profile = cfg.profiles.find((p) => p.name === key);
  if (!profile) {
    throw new Error(
      `Unknown profile "${key}". Available: ${cfg.profiles.map((p) => p.name).join(", ")}`,
    );
  }
  return resolveEngineConfig({
    root: path.resolve(profile.root),
    dataDir: profile.dataDir
      ? path.resolve(profile.dataDir)
      : undefined,
  });
}

export function upsertProfile(
  profile: RepoProfile,
  filePath?: string,
): MultiRepoConfig {
  const cfg = loadProfiles(filePath);
  const idx = cfg.profiles.findIndex((p) => p.name === profile.name);
  if (idx >= 0) cfg.profiles[idx] = profile;
  else cfg.profiles.push(profile);
  if (!cfg.default) cfg.default = profile.name;
  saveProfiles(cfg, filePath);
  return cfg;
}
