import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { shortId, sha256 } from "../util/hash.js";
import type { CodeChunk } from "../types.js";

export interface CommitSummary {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
  files: string[];
  body?: string;
}

function runGit(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

export function isGitRepo(root: string): boolean {
  return existsSync(path.join(root, ".git")) || runGit(root, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true";
}

/**
 * Harvest recent commits from the current branch.
 * Summaries are compact enough to embed/search like code chunks.
 */
export function harvestCommits(
  root: string,
  limit = 80,
): CommitSummary[] {
  if (!isGitRepo(root)) return [];

  const log = runGit(root, [
    "log",
    `-n`,
    String(limit),
    "--date=short",
    "--name-only",
    "--pretty=format:<<<%H|%h|%an|%ad|%s>>>",
  ]);
  if (!log) return [];

  const commits: CommitSummary[] = [];
  let current: CommitSummary | null = null;

  for (const line of log.split("\n")) {
    const header = line.match(/^<<<([^|>]+)\|([^|>]+)\|([^|>]*)\|([^|>]*)\|([\s\S]*)>>>$/);
    if (header) {
      if (current) commits.push(current);
      current = {
        hash: header[1],
        shortHash: header[2],
        author: header[3],
        date: header[4],
        subject: header[5],
        files: [],
      };
      continue;
    }
    if (current && line.trim()) {
      current.files.push(line.trim());
    }
  }
  if (current) commits.push(current);
  return commits;
}

/** Convert commit summaries into searchable pseudo-chunks. */
export function commitsToChunks(commits: CommitSummary[]): CodeChunk[] {
  return commits.map((c) => {
    const content = [
      `commit ${c.shortHash} ${c.date}`,
      `author: ${c.author}`,
      `subject: ${c.subject}`,
      c.files.length ? `files:\n${c.files.slice(0, 40).map((f) => `- ${f}`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    return {
      id: shortId("commit", c.hash),
      path: `.git/commits/${c.shortHash}`,
      language: "git-commit",
      startLine: 1,
      endLine: content.split("\n").length,
      content,
      symbol: c.subject.slice(0, 120),
      hash: sha256(content),
    };
  });
}
