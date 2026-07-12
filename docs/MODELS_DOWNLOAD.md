# Open-source embedding + reranker models (2025–2026)

> Updated after checking Hugging Face model cards / collections (not the broken web_search API).  
> Older picks like `bge-reranker-v2-m3` / `jina-embeddings-v2-base-code` still work, but **are no longer the frontier**.

## TL;DR — what to download for ContextEngine

### Best default kit (code retrieval, 2026)

| Role | Download this | Size | Notes |
|------|---------------|------|--------|
| **Code embedding (primary)** | [`jinaai/jina-code-embeddings-0.5b`](https://huggingface.co/jinaai/jina-code-embeddings-0.5b) | ~0.5B | 2025 code-specialist; NL2Code prompts; lighter than 1.5B |
| **Code embedding (quality)** | [`jinaai/jina-code-embeddings-1.5b`](https://huggingface.co/jinaai/jina-code-embeddings-1.5b) | ~1.5–2B | Stronger; Jina card cites high CoIR-style code retrieval |
| **General + code hybrid embed** | [`Qwen/Qwen3-Embedding-0.6B`](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) | 0.6B | 2025 Qwen3 series; multilingual + **MTEB-Code ~75**; instruct-aware |
| **Reranker (primary)** | [`jinaai/jina-reranker-v3`](https://huggingface.co/jinaai/jina-reranker-v3) | 0.6B | **2025 listwise**; card CoIR **70.64** vs bge-v2-m3 **36.28** on their table |
| **Reranker (alt / Apache-friendly stack)** | [`Qwen/Qwen3-Reranker-0.6B`](https://huggingface.co/Qwen/Qwen3-Reranker-0.6B) | 0.6B | Same family as Qwen3-Embed; MTEB-Code **73.42** in their table |

**Minimal two-model download:**

```text
1) jinaai/jina-code-embeddings-0.5b     # or Qwen3-Embedding-0.6B if you want one model for text+code
2) jinaai/jina-reranker-v3              # or Qwen3-Reranker-0.6B
```

**If VRAM is tight (laptop CPU/8GB):**

```text
1) google/embeddinggemma-300m           # 300M, has explicit "code retrieval" prompt
2) Qwen/Qwen3-Reranker-0.6B             # still 0.6B but widely quantized
# or keep pure FTS until you have GPU
```

---

## What changed vs the “old” list

| Old (2023–2024 era) | Newer (2025–2026) | Why switch |
|---------------------|-------------------|------------|
| `jina-embeddings-v2-base-code` | **`jina-code-embeddings-0.5b / 1.5b`** | New code-from-codegen line (arXiv 2508.21290); task prefixes |
| `BAAI/bge-m3` | **`Qwen3-Embedding-0.6B`** (+ optional BGE-M3 still ok) | Qwen3 leads MTEB multi-ling in 2025 card; strong code subset |
| `BAAI/bge-reranker-v2-m3` | **`jina-reranker-v3`** or **`Qwen3-Reranker-0.6B`** | v3 listwise architecture; large CoIR gap vs bge-v2-m3 on Jina’s table |
| `jina-reranker-v2-base-multilingual` | **v3** | Superseded |

BGE-M3 / bge-reranker-v2-m3 are **not bad** — just no longer the default “best open” for a new stack.

---

## Embedding models (detail)

### A. Code-first (recommended for this project)

| Model | Link | Params | Context | Dim | License / notes |
|-------|------|--------|---------|-----|-----------------|
| **jina-code-embeddings-0.5b** | [HF](https://huggingface.co/jinaai/jina-code-embeddings-0.5b) | 0.5B | long (code) | 1536 MRL | Use `nl2code` prompts |
| **jina-code-embeddings-1.5b** | [HF](https://huggingface.co/jinaai/jina-code-embeddings-1.5b) | ~1.5–2B | 32k-class | 1536 MRL | Higher quality |
| GGUF variants | [0.5b-GGUF](https://huggingface.co/jinaai/jina-code-embeddings-0.5b-GGUF), [1.5b-GGUF](https://huggingface.co/jinaai/jina-code-embeddings-1.5b-GGUF) | quant | — | — | llama.cpp style |

### B. General SOTA open embeds (also good at code)

| Model | Link | Params | Why |
|-------|------|--------|-----|
| **Qwen3-Embedding-0.6B** | [HF](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) | 0.6B | Hot on HF; instruct; MTEB-Code ~75 (card) |
| **Qwen3-Embedding-4B** | [HF](https://huggingface.co/Qwen/Qwen3-Embedding-4B) | 4B | If you have GPU headroom |
| **Qwen3-Embedding-8B** | [HF](https://huggingface.co/Qwen/Qwen3-Embedding-8B) | 8B | Card: MTEB multi-ling #1 as of mid-2025 |
| **jina-embeddings-v5-text-small** | [HF](https://huggingface.co/jinaai/jina-embeddings-v5-text-small) | 0.6B | 5th-gen Jina text (2026 collection) |
| **jina-embeddings-v5-text-nano** | [HF](https://huggingface.co/jinaai/jina-embeddings-v5-text-nano) | 0.2B | Lightweight v5 |
| **google/embeddinggemma-300m** | [HF](https://huggingface.co/google/embeddinggemma-300m) | 300M | On-device; **code retrieval** task prompt; needs license accept |
| **LiquidAI/LFM2.5-Embedding-350M** | [HF](https://huggingface.co/LiquidAI/LFM2.5-Embedding-350M) | 350M | Recent compact embed |

### C. Still valid but older

| Model | When to still use |
|-------|-------------------|
| `jinaai/jina-embeddings-v2-base-code` | Already downloaded / CPU only |
| `BAAI/bge-m3` | Hybrid dense+sparse; multi-lang docs |
| `Salesforce/SFR-Embedding-Code-400M_R` | Strong CoIR research baseline |

---

## Reranker models (detail)

| Model | Link | Params | Code-ish signal | Notes |
|-------|------|--------|-----------------|--------|
| **jina-reranker-v3** | [HF](https://huggingface.co/jinaai/jina-reranker-v3) | 0.6B | CoIR **70.64** (their table) | Listwise; **CC BY-NC** for raw weights — commercial via Jina API/cloud |
| **Qwen3-Reranker-0.6B** | [HF](https://huggingface.co/Qwen/Qwen3-Reranker-0.6B) | 0.6B | MTEB-Code **73.42** | Pairs with Qwen3-Embed; Apache-class Qwen licensing (check card) |
| **Qwen3-Reranker-4B** | [HF](https://huggingface.co/Qwen/Qwen3-Reranker-4B) | 4B | MTEB-Code **81.20** | Best open quality if GPU allows |
| **mixedbread-ai/mxbai-rerank-large-v2** | [HF](https://huggingface.co/mixedbread-ai/mxbai-rerank-large-v2) | ~1.5–2B | CoIR ~71 on Jina table | Competitive large CE |
| **nvidia/llama-nemotron-rerank-1b-v2** | [HF](https://huggingface.co/nvidia/llama-nemotron-rerank-1b-v2) | 1B | enterprise stack | Newer NVIDIA line |
| **tencent/R3-rerank-0.6b** | [HF](https://huggingface.co/tencent/R3-rerank-0.6b) | 0.6B | trending | Very new; less battle-tested docs |
| bge-reranker-v2-m3 | [HF](https://huggingface.co/BAAI/bge-reranker-v2-m3) | 0.6B | CoIR weak on Jina table | Legacy default |

---

## Download commands (copy-paste)

```bash
pip install -U "huggingface_hub[cli]"
huggingface-cli login   # if needed (Gemma, some gates)
mkdir -p ~/models && cd ~/models

# === 2026 recommended ===
huggingface-cli download jinaai/jina-code-embeddings-0.5b --local-dir jina-code-embeddings-0.5b
huggingface-cli download jinaai/jina-code-embeddings-1.5b --local-dir jina-code-embeddings-1.5b
huggingface-cli download Qwen/Qwen3-Embedding-0.6B --local-dir Qwen3-Embedding-0.6B
huggingface-cli download jinaai/jina-reranker-v3 --local-dir jina-reranker-v3
huggingface-cli download Qwen/Qwen3-Reranker-0.6B --local-dir Qwen3-Reranker-0.6B

# === optional quality / small ===
huggingface-cli download Qwen/Qwen3-Embedding-4B --local-dir Qwen3-Embedding-4B
huggingface-cli download Qwen/Qwen3-Reranker-4B --local-dir Qwen3-Reranker-4B
huggingface-cli download google/embeddinggemma-300m --local-dir embeddinggemma-300m
huggingface-cli download jinaai/jina-embeddings-v5-text-small --local-dir jina-embeddings-v5-text-small

# === GGUF if you use llama.cpp ===
huggingface-cli download jinaai/jina-code-embeddings-0.5b-GGUF --local-dir jina-code-embeddings-0.5b-GGUF
huggingface-cli download jinaai/jina-reranker-v3-GGUF --local-dir jina-reranker-v3-GGUF
```

Disk ballpark: **0.5B–0.6B bf16 ≈ 1–1.5 GB each**; 1.5B–4B models several GB+.

---

## Pairing recipes

### Recipe 1 — Code agent ContextEngine (best open balance)

```text
Embed:  jina-code-embeddings-0.5b  (or 1.5b)
Rerank: jina-reranker-v3
Query:  use nl2code instruction on embed side
```

### Recipe 2 — One family, simpler ops

```text
Embed:  Qwen3-Embedding-0.6B
Rerank: Qwen3-Reranker-0.6B
```

### Recipe 3 — Max open quality (GPU)

```text
Embed:  Qwen3-Embedding-4B  or  jina-code-embeddings-1.5b
Rerank: Qwen3-Reranker-4B   or  jina-reranker-v3
```

### Recipe 4 — Commercial-safe self-host caution

- Prefer **Qwen3** stack if you need clearer open licensing for on-prem product.  
- **jina-reranker-v3** weights are **CC BY-NC** for raw company on-prem (per card); API/cloud is their commercial path.  
- Always re-read the model card license before shipping.

---

## Wire into ContextEngine (after download)

ContextEngine expects OpenAI-compatible **`/v1/embeddings`**. Reranker is **not integrated yet** (feature rerank only).

```bash
# Example: TEI for Qwen3-Embedding-0.6B
docker run --gpus all -p 8080:80 -v $HOME/models/Qwen3-Embedding-0.6B:/data \
  ghcr.io/huggingface/text-embeddings-inference:1.7.2 \
  --model-id /data --dtype float16

export OPENAI_BASE_URL=http://127.0.0.1:8080/v1
export OPENAI_API_KEY=dummy
export OPENAI_EMBEDDING_MODEL=Qwen3-Embedding-0.6B
contextengine index   # rebuild vectors
```

For Jina code embeds, encode **queries** with the `nl2code` instruction prefix (see model card).

---

## Sources checked

- HF trending: feature-extraction / sentence-similarity / text-ranking  
- [jina-code-embeddings collection](https://huggingface.co/collections/jinaai/jina-code-embeddings)  
- [jina-embeddings-v5-text collection](https://huggingface.co/collections/jinaai/jina-embeddings-v5-text)  
- Model cards: Qwen3-Embedding/Reranker, jina-reranker-v3, EmbeddingGemma  

*web_search API remains broken in this environment; numbers above are from model cards, not a live MTEB scrape.*
