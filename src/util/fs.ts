import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import path from "node:path";
import ignore, { type Ignore } from "ignore";

const DEFAULT_IGNORES = [
  "node_modules/",
  ".git/",
  ".svn/",
  ".hg/",
  "dist/",
  "build/",
  "out/",
  "coverage/",
  ".next/",
  ".nuxt/",
  ".turbo/",
  ".cache/",
  ".contextengine/",
  "vendor/",
  "target/",
  "__pycache__/",
  ".venv/",
  "venv/",
  "*.min.js",
  "*.min.css",
  "*.map",
  "*.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "*.png",
  "*.jpg",
  "*.jpeg",
  "*.gif",
  "*.webp",
  "*.ico",
  "*.pdf",
  "*.zip",
  "*.tar",
  "*.gz",
  "*.woff",
  "*.woff2",
  "*.ttf",
  "*.eot",
  "*.mp4",
  "*.mp3",
  "*.wasm",
  "*.bin",
  "*.exe",
  "*.dll",
  "*.so",
  "*.dylib",
  "*.class",
  "*.o",
  "*.a",
];

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".kts",
  ".scala",
  ".rb",
  ".php",
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".h",
  ".hpp",
  ".cs",
  ".swift",
  ".m",
  ".mm",
  ".vue",
  ".svelte",
  ".astro",
  ".md",
  ".mdx",
  ".json",
  ".jsonc",
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
  ".sql",
  ".graphql",
  ".gql",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".bat",
  ".dockerfile",
  ".txt",
  ".rst",
  ".proto",
  ".thrift",
  ".cmake",
  ".gradle",
  ".r",
  ".jl",
  ".lua",
  ".pl",
  ".ex",
  ".exs",
  ".erl",
  ".hs",
  ".clj",
  ".cljs",
  ".edn",
  ".zig",
  ".nim",
  ".dart",
  ".tf",
  ".hcl",
]);

const LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".rb": "ruby",
  ".php": "php",
  ".c": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".swift": "swift",
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
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
};

export function languageForPath(filePath: string): string {
  const base = path.basename(filePath).toLowerCase();
  if (base === "dockerfile") return "dockerfile";
  if (base === "makefile") return "makefile";
  const ext = path.extname(filePath).toLowerCase();
  return LANGUAGE_BY_EXT[ext] ?? (ext ? ext.slice(1) : "text");
}

function loadIgnore(root: string): Ignore {
  const ig = ignore().add(DEFAULT_IGNORES);
  for (const name of [".gitignore", ".contextengineignore"]) {
    const p = path.join(root, name);
    if (existsSync(p)) {
      try {
        ig.add(readFileSync(p, "utf8"));
      } catch {
        // ignore unreadable ignore files
      }
    }
  }
  return ig;
}

export interface WalkedFile {
  absPath: string;
  relPath: string;
  size: number;
}

export function walkSourceFiles(
  root: string,
  maxFileBytes: number,
): WalkedFile[] {
  const ig = loadIgnore(root);
  const out: WalkedFile[] = [];

  const walk = (dir: string): void => {
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
        TEXT_EXTENSIONS.has(ext) ||
        base === "dockerfile" ||
        base === "makefile" ||
        base === "cmakelists.txt" ||
        !ext;
      if (!looksText && ext) continue;
      let size = 0;
      try {
        size = statSync(abs).size;
      } catch {
        continue;
      }
      if (size <= 0 || size > maxFileBytes) continue;
      // Skip likely-binary by extension already; also skip empty-ish
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
    // Heuristic: reject if too many null bytes
    const sample = buf.subarray(0, Math.min(buf.length, 2048));
    let nulls = 0;
    for (const b of sample) if (b === 0) nulls++;
    if (nulls > 2) return null;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}
