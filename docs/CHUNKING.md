# Code chunking strategy (research + our implementation)

## Does every language need different rules?

**Yes — structure differs, so split rules must differ.**

| Language family | Structure cue | Preferred unit | Notes |
|-----------------|---------------|----------------|-------|
| **C / C++** | Braces `{}`, free functions, structs, `#include` preamble | Function / type definition | Headers often declare-only; keep types with nearby helpers |
| **Java / Kotlin / C#** | Braces, class-centric, methods nested | Class or method | Methods need outer class name for identity when possible |
| **Go** | Braces, `func`, `type`, package | Function / type | Receivers matter (`func (s *T)`) |
| **Rust** | Braces, `fn`, `impl`, `mod` | Function / impl block | `impl` blocks are natural units |
| **Python / Ruby** | Indentation, `def`/`class` | Function / class | Decorators must attach to following def |
| **JS / TS** | Braces, export, classes, arrow funcs | Function / class / exported const | React components often `const X = () =>` |
| **Markdown / docs** | Headings | Section under `#`/`##` | Not code, but useful for “how to” |

Flat character/token windows **ignore** these cues and routinely split mid-function, which hurts both BM25 and embeddings.

## What research says is “best”

Sources surveyed (2025–2026 RAG-for-code literature / practice):

1. **Structure-aware > fixed token windows** for *code Q&A / agent retrieval*  
   (AST or heuristic function/class boundaries; CAST / tree-sitter style work).
2. **Task-dependent:**
   - **Semantic search / “where is X implemented?”** → prefer **function / type / class** units + path/symbol metadata.
   - **Line-level completion** → sometimes **sliding window** wins (different product).
3. **Metadata matters:** path, symbol name, language should travel with the chunk (we prefix path/symbol into BM25 + embed text).
4. **Size:** keep units under a few KB; if a class is huge, split at **method** boundaries, not mid-statement.
5. **Overlap:** small line overlap (or attached leading comments) preserves call-site continuity.
6. **Preamble:** file-level imports/package should attach to first real unit (or stay as a short “header” chunk).

We do **not** claim tree-sitter-level precision yet (no native AST dependency).  
We use **language profiles + brace/indent unit ends** — a practical middle ground that scales without native addons.

## Our policy (locked)

```text
1. Detect language by extension / special filenames
2. Find unit starts with language-specific regex (indent-aware for Python/Ruby)
3. Close units with:
   - indent block (Python/Ruby)
   - brace matching with string/comment awareness (C-family, JVM, Go, Rust, …)
4. Attach immediately preceding comments/decorators/attributes to the unit
5. Keep package/import preamble as its own small chunk if long enough
6. Soft-split oversized units by secondary max-lines budget
7. Tiny trailing fragments merge into previous unit
8. Emit path + symbol + hash for indexing
```

## Per-language unit start (summary)

See `src/chunker/code-chunker.ts` → `SPLIT_PATTERNS` / `BRACE_LANGS` / indent languages.

## Evaluation

Multi-language semantic benches live under `examples/eval.*.json` and  
`scripts/bench-multilang.mjs` (requires embedding endpoint).
