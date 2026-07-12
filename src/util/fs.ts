import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import path from "node:path";
import ignore, { type Ignore } from "ignore";

/**
 * Built-in excludes (Augment-style "smart filtering"):
 * dependencies, VCS, build/generated, secrets, binaries, caches, IDE.
 * Applied first; then .gitignore / .augmentignore / .contextengineignore.
 */
export const DEFAULT_IGNORES = [
  // Dependencies
  "node_modules/",
  "bower_components/",
  "jspm_packages/",
  "vendor/",
  "Pods/",
  "Carthage/",
  ".bundle/",
  // VCS
  ".git/",
  ".svn/",
  ".hg/",
  // Build / output
  "dist/",
  "build/",
  "out/",
  "output/",
  "bin/",
  "obj/",
  "target/",
  "Debug/",
  "Release/",
  "cmake-build-*/",
  "coverage/",
  ".coverage/",
  "htmlcov/",
  ".nyc_output/",
  ".next/",
  ".nuxt/",
  ".turbo/",
  ".cache/",
  ".parcel-cache/",
  ".svelte-kit/",
  ".vercel/",
  ".netlify/",
  "storybook-static/",
  // Python
  "__pycache__/",
  ".venv/",
  "venv/",
  ".tox/",
  ".mypy_cache/",
  ".pytest_cache/",
  ".ruff_cache/",
  "*.egg-info/",
  ".eggs/",
  // Our index
  ".contextengine/",
  // Locks & minified
  "*.min.js",
  "*.min.css",
  "*.map",
  "*.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
  "composer.lock",
  "Gemfile.lock",
  "go.sum",
  // Secrets / env
  ".env",
  ".env.*",
  "!.env.example",
  "!.env.sample",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "credentials.json",
  "service-account*.json",
  // IDE / OS
  ".idea/",
  ".vscode/",
  "*.swp",
  "*.swo",
  "*~",
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
  // Binaries / media
  "*.png",
  "*.jpg",
  "*.jpeg",
  "*.gif",
  "*.webp",
  "*.ico",
  "*.svg",
  "*.pdf",
  "*.zip",
  "*.tar",
  "*.gz",
  "*.7z",
  "*.rar",
  "*.woff",
  "*.woff2",
  "*.ttf",
  "*.eot",
  "*.mp4",
  "*.mp3",
  "*.wav",
  "*.wasm",
  "*.bin",
  "*.exe",
  "*.dll",
  "*.so",
  "*.dylib",
  "*.class",
  "*.jar",
  "*.war",
  "*.ear",
  "*.o",
  "*.a",
  "*.lib",
  "*.obj",
  "*.pyc",
  "*.pyo",
  "*.pdb",
  "*.ilk",
  // Generated / vendored noise
  "*.generated.*",
  "*_generated.*",
  "*.g.dart",
  "*.freezed.dart",
  "generated/",
  "gen/",
  "third_party/",
  "third-party/",
  // Heavy test/benchmark trees (still overridable with ! in .augmentignore)
  "**/androidHostTest/",
  "**/androidTest/",
  "**/jvmTest/",
  "**/commonTest/",
  "**/hostTest/",
  "**/benchmarks/",
  "**/fuzzing/",
  "**/testdata/",
  "**/test-data/",
];

/** Extensions we treat as indexable text source. */
export const TEXT_EXTENSIONS = new Set([
  // JS/TS
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  // Python
  ".py",
  ".pyi",
  // Go / Rust
  ".go",
  ".rs",
  // JVM
  ".java",
  ".kt",
  ".kts",
  ".scala",
  ".groovy",
  // C / C++
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".c++",
  ".h",
  ".hh",
  ".hpp",
  ".hxx",
  ".h++",
  ".inl",
  ".ipp",
  // C# / .NET
  ".cs",
  ".fs",
  ".fsx",
  ".vb",
  // Apple
  ".swift",
  ".m",
  ".mm",
  // Web UI
  ".vue",
  ".svelte",
  ".astro",
  // Scripting
  ".rb",
  ".php",
  ".pl",
  ".pm",
  ".lua",
  ".r",
  ".jl",
  ".ex",
  ".exs",
  ".erl",
  ".hrl",
  ".hs",
  ".lhs",
  ".clj",
  ".cljs",
  ".cljc",
  ".edn",
  ".zig",
  ".nim",
  ".dart",
  ".sol",
  // Infra / config
  ".md",
  ".mdx",
  ".rst",
  ".txt",
  ".json",
  ".jsonc",
  ".json5",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".xml",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".less",
  ".sass",
  ".sql",
  ".graphql",
  ".gql",
  ".proto",
  ".thrift",
  ".avsc",
  ".cmake",
  ".gradle",
  ".tf",
  ".hcl",
  ".bicep",
  ".nix",
  // Shell
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".bat",
  ".cmd",
  // Misc
  ".dockerfile",
]);

const LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".scala": "scala",
  ".groovy": "groovy",
  ".rb": "ruby",
  ".php": "php",
  ".c": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".c++": "cpp",
  ".h": "c",
  ".hh": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
  ".h++": "cpp",
  ".inl": "cpp",
  ".ipp": "cpp",
  ".cs": "csharp",
  ".fs": "fsharp",
  ".swift": "swift",
  ".m": "objective-c",
  ".mm": "objective-cpp",
  ".vue": "vue",
  ".svelte": "svelte",
  ".md": "markdown",
  ".mdx": "markdown",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".sql": "sql",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".dart": "dart",
  ".sol": "solidity",
  ".proto": "protobuf",
  ".tf": "terraform",
  ".hcl": "hcl",
};

export function languageForPath(filePath: string): string {
  const base = path.basename(filePath).toLowerCase();
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
  if (base === "makefile" || base === "gnumakefile") return "makefile";
  if (base === "cmakelists.txt") return "cmake";
  if (base === "build.gradle" || base === "build.gradle.kts") return "gradle";
  if (base === "pom.xml") return "xml";
  const ext = path.extname(filePath).toLowerCase();
  return LANGUAGE_BY_EXT[ext] ?? (ext ? ext.slice(1) : "text");
}

function readIgnoreFile(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

/**
 * Build ignore matcher for a workspace root.
 * Priority (later can re-include with !):
 *   1) DEFAULT_IGNORES
 *   2) .gitignore (root)
 *   3) .augmentignore (Augment-compatible)
 *   4) .contextengineignore
 *
 * Negation (`!pattern`) is supported via the `ignore` package, matching Augment docs.
 */
export function loadIgnore(root: string, extraPatterns: string[] = []): Ignore {
  const ig = ignore().add(DEFAULT_IGNORES);
  // Root ignore files — order matches Augment: gitignore then product ignore
  for (const name of [".gitignore", ".augmentignore", ".contextengineignore"]) {
    const p = path.join(root, name);
    if (existsSync(p)) {
      const text = readIgnoreFile(p);
      if (text) ig.add(text);
    }
  }
  if (extraPatterns.length) ig.add(extraPatterns);
  return ig;
}

/**
 * When walking into subdirs, apply nested .gitignore relative to that dir
 * by prefixing patterns with the directory path (gitignore semantics).
 */
function addNestedGitignore(
  rootIg: Ignore,
  root: string,
  relDir: string,
): void {
  const gi = path.join(root, relDir, ".gitignore");
  if (!existsSync(gi)) return;
  const text = readIgnoreFile(gi);
  if (!text.trim()) return;
  const prefix = relDir.replace(/\\/g, "/").replace(/\/?$/, "/");
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const t = line.trim();
    if (!t || t.startsWith("#")) {
      lines.push(line);
      continue;
    }
    // Keep negation, then prefix path
    if (t.startsWith("!")) {
      const rest = t.slice(1);
      if (rest.startsWith("/")) {
        lines.push("!" + prefix + rest.replace(/^\//, ""));
      } else {
        lines.push("!" + prefix + rest);
      }
    } else if (t.startsWith("/")) {
      lines.push(prefix + t.replace(/^\//, ""));
    } else {
      // Pattern may match in this subtree; gitignore relative patterns apply under this dir
      lines.push(prefix + t);
    }
  }
  rootIg.add(lines.join("\n"));
}

export interface WalkedFile {
  absPath: string;
  relPath: string;
  size: number;
}

export interface WalkOptions {
  /** Extra gitignore-style patterns (CLI --exclude). */
  extraIgnores?: string[];
  /** If true, skip extension allow-list and index any non-binary text. */
  allText?: boolean;
}

export function walkSourceFiles(
  root: string,
  maxFileBytes: number,
  options: WalkOptions = {},
): WalkedFile[] {
  const ig = loadIgnore(root, options.extraIgnores ?? []);
  const out: WalkedFile[] = [];
  // Track which dirs already contributed nested gitignore
  const nestedLoaded = new Set<string>([""]);

  const walk = (dir: string): void => {
    const relDir = path.relative(root, dir).split(path.sep).join("/");
    if (relDir && !nestedLoaded.has(relDir)) {
      addNestedGitignore(ig, root, relDir);
      nestedLoaded.add(relDir);
    }

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (!rel || rel === ".") continue;
      if (ig.ignores(rel) || ig.ignores(rel + (ent.isDirectory() ? "/" : ""))) {
        continue;
      }
      if (ent.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!ent.isFile()) continue;
      const ext = path.extname(ent.name).toLowerCase();
      const base = ent.name.toLowerCase();
      const looksText =
        options.allText ||
        TEXT_EXTENSIONS.has(ext) ||
        base === "dockerfile" ||
        base.startsWith("dockerfile.") ||
        base === "makefile" ||
        base === "gnumakefile" ||
        base === "cmakelists.txt" ||
        base === "build.gradle" ||
        base === "build.gradle.kts" ||
        base === "pom.xml" ||
        !ext;
      if (!looksText && ext) continue;
      let size = 0;
      try {
        size = statSync(abs).size;
      } catch {
        continue;
      }
      if (size <= 0 || size > maxFileBytes) continue;
      out.push({ absPath: abs, relPath: rel, size });
    }
  };

  walk(root);
  return out;
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function readTextFile(absPath: string): string | null {
  try {
    const buf = readFileSync(absPath);
    // Heuristic: reject if too many null bytes (binary)
    const sample = buf.subarray(0, Math.min(buf.length, 2048));
    let nulls = 0;
    for (const b of sample) if (b === 0) nulls++;
    if (nulls > 2) return null;
    // Reject if mostly non-printable (excluding tab/lf/cr)
    let nonPrint = 0;
    for (const b of sample) {
      if (b === 9 || b === 10 || b === 13) continue;
      if (b < 32 || b === 127) nonPrint++;
    }
    if (sample.length > 0 && nonPrint / sample.length > 0.3) return null;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}
