import path from "node:path";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { sourcePathAllowed } from "../source-access.js";
import type { SourcePathPolicy } from "../types.js";
import { readTextFile } from "../util/fs.js";

/**
 * Team-knowledge / guideline files an agent should honor, discovered from the
 * workspace the way Augment's CLI grounds retrieval in `AGENTS.md`,
 * `CLAUDE.md`, and `.augment/rules`. This is not a retrieval channel — the
 * rules are prepended to the packed context so the model always sees the
 * repo's conventions, not just matching code.
 */
export interface WorkspaceRule {
  /** Workspace-relative source path (stable, forward-slashed). */
  path: string;
  /** Short display name derived from the file. */
  name: string;
  /** Rule body with any frontmatter stripped. */
  content: string;
  /**
   * `always` rules are unconditional repo conventions (AGENTS.md, CLAUDE.md,
   * or a rule whose frontmatter sets `alwaysApply: true`). `agent-requested`
   * rules are scoped and only surface when relevant. Mirrors Augment's
   * always / agent-requested precedence.
   */
  scope: "always" | "agent-requested";
}

export interface LoadRulesOptions {
  /** Max bytes to read from any single rule file (default 32 KiB). */
  maxBytesPerRule?: number;
  /** Max number of rules to return (default 24). */
  maxRules?: number;
  /** Server-enforced visibility policy; denied rules are never read. */
  sourceAccess?: SourcePathPolicy;
  /** Indexed-path prefix for the primary root in a multi-root workspace. */
  sourcePathPrefix?: string;
}

const DEFAULT_MAX_BYTES = 32 * 1024;
const DEFAULT_MAX_RULES = 24;

/** Root-level convention files, highest precedence, always applied. */
const ROOT_RULE_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

/** Directories scanned for individual rule files. */
const RULE_DIRECTORIES = [
  path.join(".augment", "rules"),
  path.join(".cursor", "rules"),
] as const;

const RULE_FILE_EXTENSIONS = new Set([".md", ".mdc", ".txt"]);

/**
 * Discover and order workspace rules for a root. Precedence (highest first):
 * root convention files (AGENTS.md, CLAUDE.md), then `.augment/rules` and
 * `.cursor/rules` entries. `always` rules sort ahead of `agent-requested`.
 */
export function loadWorkspaceRules(
  root: string,
  options: LoadRulesOptions = {},
): WorkspaceRule[] {
  const maxBytes = options.maxBytesPerRule ?? DEFAULT_MAX_BYTES;
  const maxRules = options.maxRules ?? DEFAULT_MAX_RULES;
  const sourceAccess = options.sourceAccess;
  const sourcePathPrefix = options.sourcePathPrefix;
  const rules: WorkspaceRule[] = [];
  const seen = new Set<string>();

  // Canonicalize the root once so every rule file can be checked against it.
  // A malicious repo can plant a rule file that is a symlink to a secret
  // outside the workspace (e.g. ~/.ssh/id_rsa); reading it would leak the
  // target into packed context. Mirror the realpath containment discipline
  // that getFileContext already enforces for on-demand file reads.
  const absoluteRoot = path.resolve(root);
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync.native(absoluteRoot);
  } catch {
    return [];
  }

  for (const fileName of ROOT_RULE_FILES) {
    const abs = path.join(absoluteRoot, fileName);
    const rule = readRuleFile(
      abs,
      fileName,
      maxBytes,
      "always",
      canonicalRoot,
      sourceAccess,
      sourcePathPrefix,
    );
    if (rule && !seen.has(rule.path)) {
      seen.add(rule.path);
      rules.push(rule);
    }
  }

  for (const dir of RULE_DIRECTORIES) {
    const absDir = path.join(absoluteRoot, dir);
    for (const entry of listRuleFiles(absDir)) {
      const rel = path.join(dir, entry);
      const abs = path.join(absoluteRoot, rel);
      const rule = readRuleFile(
        abs,
        rel,
        maxBytes,
        "agent-requested",
        canonicalRoot,
        sourceAccess,
        sourcePathPrefix,
      );
      if (rule && !seen.has(rule.path)) {
        seen.add(rule.path);
        rules.push(rule);
      }
    }
  }

  rules.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === "always" ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
  return rules.slice(0, maxRules);
}

/** Render discovered rules as a bounded Markdown preamble for packed context. */
export function formatRulesSection(
  rules: readonly WorkspaceRule[],
  maxChars?: number,
): string {
  if (!rules.length) return "";
  const blocks = rules.map((rule) => {
    const label = rule.scope === "always" ? "always" : "agent-requested";
    return `## Rule: ${rule.name} (${label})\nsource: ${rule.path}\n\n${rule.content.trim()}`;
  });
  let section = [
    `# Workspace rules`,
    ``,
    `Repository conventions the change must follow.`,
    ``,
    blocks.join("\n\n"),
  ].join("\n");
  if (maxChars !== undefined && section.length > maxChars) {
    section = section.slice(0, Math.max(0, maxChars));
  }
  return section;
}

function listRuleFiles(absDir: string): string[] {
  if (!existsSync(absDir)) return [];
  try {
    if (!statSync(absDir).isDirectory()) return [];
    return readdirSync(absDir)
      .filter((name) => RULE_FILE_EXTENSIONS.has(path.extname(name).toLowerCase()))
      .sort();
  } catch {
    return [];
  }
}

function readRuleFile(
  abs: string,
  relPath: string,
  maxBytes: number,
  defaultScope: WorkspaceRule["scope"],
  canonicalRoot: string,
  sourceAccess: SourcePathPolicy | undefined,
  sourcePathPrefix: string | undefined,
): WorkspaceRule | null {
  const relativeSourcePath = relPath.split(path.sep).join("/");
  const sourcePath = sourcePathPrefix
    ? `${sourcePathPrefix}/${relativeSourcePath}`
    : relativeSourcePath;
  // Apply authorization before touching the file so denied content never
  // enters the process or a packed-context trace.
  if (!sourcePathAllowed(sourceAccess, sourcePath)) return null;
  if (!existsSync(abs)) return null;
  // Resolve the real path and reject anything that escapes the workspace root
  // (e.g. a rule file that is a symlink to a secret elsewhere on disk).
  let canonicalFile: string;
  try {
    canonicalFile = realpathSync.native(abs);
  } catch {
    return null;
  }
  if (!isPathWithin(canonicalRoot, canonicalFile)) return null;
  const raw = readTextFile(canonicalFile);
  if (raw === null) return null;
  const bounded = raw.length > maxBytes ? raw.slice(0, maxBytes) : raw;
  const { body, alwaysApply } = stripFrontmatter(bounded);
  const trimmed = body.trim();
  if (!trimmed) return null;
  const scope: WorkspaceRule["scope"] =
    alwaysApply === true
      ? "always"
      : alwaysApply === false
        ? "agent-requested"
        : defaultScope;
  return {
    path: sourcePath,
    name: path.basename(relPath),
    content: trimmed,
    scope,
  };
}

/**
 * Strip a leading YAML-ish frontmatter block, returning the body and any
 * `alwaysApply` flag. Deliberately tiny — no YAML dependency, only the couple
 * of keys rule files actually use.
 */
function stripFrontmatter(text: string): {
  body: string;
  alwaysApply?: boolean;
} {
  if (!text.startsWith("---")) return { body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { body: text };
  const frontmatter = text.slice(3, end);
  const rest = text.slice(end + 4).replace(/^\r?\n/, "");
  let alwaysApply: boolean | undefined;
  for (const line of frontmatter.split("\n")) {
    const match = /^\s*always[_-]?apply\s*:\s*(true|false)\s*$/i.exec(line);
    if (match) alwaysApply = match[1].toLowerCase() === "true";
  }
  return { body: rest, alwaysApply };
}

/** True when `candidate` is the root itself or nested within it. */
function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}
