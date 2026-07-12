# Open-source embedding + reranker models (download list)

Curated for **code / technical retrieval** pipelines like ContextEngine.  
All links are Hugging Face; use `huggingface-cli` or `git lfs`.

## Recommended download set (start here)

| Role | Model ID | Size (approx) | Why |
|------|----------|---------------|-----|
| **Code embed (small, first download)** | [`jinaai/jina-embeddings-v2-base-code`](https://huggingface.co/jinaai/jina-embeddings-v2-base-code) | ~160M params | Mature code embed, 30 langs, easy, popular |
| **Code embed (stronger, 2025)** | [`jinaai/jina-code-embeddings-0.5b`](https://huggingface.co/jinaai/jina-code-embeddings-0.5b) | ~0.5B | Newer Jina code line, task prompts |
| **Code embed (best open quality if GPU ok)** | [`jinaai/jina-code-embeddings-1.5b`](https://huggingface.co/jinaai/jina-code-embeddings-1.5b) | ~1.5–2B | Qwen2.5-Coder based, strong NL2Code |
| **Code embed (research strong, CoIR)** | [`Salesforce/SFR-Embedding-Code-400M_R`](https://huggingface.co/Salesforce/SFR-Embedding-Code-400M_R) | ~400M | High CoIR scores among open models |
| **Code embed (larger SFR)** | [`Salesforce/SFR-Embedding-Code-2B_R`](https://huggingface.co/Salesforce/SFR-Embedding-Code-2B_R) | ~2B | Higher quality, heavier |
| **General multi-lang embed** | [`BAAI/bge-m3`](https://huggingface.co/BAAI/bge-m3) | ~570M | Dense+sparse+colbert; great hybrid base |
| **Reranker (default, open commercial-friendly)** | [`BAAI/bge-reranker-v2-m3`](https://huggingface.co/BAAI/bge-reranker-v2-m3) | ~568M | Standard open reranker, multi-lang |
| **Reranker (lighter)** | [`BAAI/bge-reranker-base`](https://huggingface.co/BAAI/bge-reranker-base) | ~278M | Faster, slightly weaker |
| **Reranker (strong + code-aware claims)** | [`jinaai/jina-reranker-v2-base-multilingual`](https://huggingface.co/jinaai/jina-reranker-v2-base-multilingual) | ~278M | Good CodeSearchNet MRR in Jina table; **check license (CC-BY-NC for research weights)** |
| **Reranker (LLM-class, heavy)** | [`BAAI/bge-reranker-v2-gemma`](https://huggingface.co/BAAI/bge-reranker-v2-gemma) | ~2B | Higher quality, needs more VRAM |

### Minimal kit (laptop / first try)

```text
1) jinaai/jina-embeddings-v2-base-code
2) BAAI/bge-reranker-v2-m3
```

### Quality kit (desktop GPU ≥ 12–16GB)

```text
1) jinaai/jina-code-embeddings-1.5b   # or Salesforce/SFR-Embedding-Code-400M_R if VRAM tight
2) BAAI/bge-reranker-v2-m3            # or jina-reranker-v2-base-multilingual
```

---

## Download commands

### Option A — Hugging Face CLI (recommended)

```bash
# once
pip install -U "huggingface_hub[cli]"

# directory for weights
mkdir -p ~/models && cd ~/models

# --- embeddings ---
huggingface-cli download jinaai/jina-embeddings-v2-base-code --local-dir jina-embeddings-v2-base-code
huggingface-cli download jinaai/jina-code-embeddings-0.5b --local-dir jina-code-embeddings-0.5b
huggingface-cli download jinaai/jina-code-embeddings-1.5b --local-dir jina-code-embeddings-1.5b
huggingface-cli download Salesforce/SFR-Embedding-Code-400M_R --local-dir SFR-Embedding-Code-400M_R
huggingface-cli download Salesforce/SFR-Embedding-Code-2B_R --local-dir SFR-Embedding-Code-2B_R
huggingface-cli download BAAI/bge-m3 --local-dir bge-m3

# --- rerankers ---
huggingface-cli download BAAI/bge-reranker-v2-m3 --local-dir bge-reranker-v2-m3
huggingface-cli download BAAI/bge-reranker-base --local-dir bge-reranker-base
huggingface-cli download jinaai/jina-reranker-v2-base-multilingual --local-dir jina-reranker-v2-base-multilingual
huggingface-cli download BAAI/bge-reranker-v2-gemma --local-dir bge-reranker-v2-gemma
```

Need auth for some gated models:

```bash
huggingface-cli login
```

### Option B — git-lfs

```bash
git lfs install
git clone https://huggingface.co/jinaai/jina-embeddings-v2-base-code
git clone https://huggingface.co/BAAI/bge-reranker-v2-m3
# ...
```

### Option C — GGUF (llama.cpp / some local servers)

If you prefer quantized GGUF for embed:

- Search HF: `jina-embeddings-v2-base-code GGUF`  
  e.g. community quant repos under `*jina-embeddings-v2-base-code*GGUF*`

Rerankers are usually **not** GGUF-first; use transformers / FlagEmbedding.

---

## How they fit the pipeline (vs Augment)

```text
user task
  → (optional) LLM rewrites to information_request   ← agent side, like Augment UX
  → hybrid retrieve: BM25/FTS + dense embed
  → cross-encoder rerank top 20–50
  → pack context for agent
```

| Component | Open model role |
|-----------|-----------------|
| Dense recall | Jina code / SFR-Code / BGE-M3 |
| Lexical recall | our FTS5 BM25 (no download) |
| Rerank | bge-reranker-v2-m3 / jina-reranker-v2 |
| Query rewrite | any chat LLM (Claude/Qwen/DeepSeek) — **not** an embedding model |

---

## Notes on quality claims

- **SFR-Embedding-Code** reports strong **CoIR** (code retrieval) numbers in their card.  
- **Jina code embeddings 1.5b** (2025 paper arXiv:2508.21290) is purpose-built for NL2Code / code2code.  
- **jina-reranker-v2** publishes CodeSearchNet MRR competitive with bge-reranker-v2-m3; check **license** before commercial use.  
- **bge-reranker-v2-m3** is the community default open reranker (BEIR / multi-lang).  
- Closed APIs still often lead overall (Voyage-Code, OpenAI large); open stack above is the best free path.

---

## After download — serve as OpenAI-compatible (for ContextEngine)

ContextEngine today talks to **`POST /v1/embeddings`**. Options:

1. **Hugging Face TEI** (Text Embeddings Inference) for embed models  
2. **vLLM** `task=embed` for jina-code-embeddings  
3. **Ollama** if the model is published there  
4. Thin FastAPI wrapper around `sentence-transformers`

Example (TEI, docker — adjust model path):

```bash
docker run --gpus all -p 8080:80 \
  -v $HOME/models/jina-embeddings-v2-base-code:/data \
  ghcr.io/huggingface/text-embeddings-inference:latest \
  --model-id /data
```

Then:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8080/v1
export OPENAI_API_KEY=dummy
export OPENAI_EMBEDDING_MODEL=jina-embeddings-v2-base-code
contextengine index
```

Reranker integration is **not wired in ContextEngine yet** (we use feature rerank).  
Next engineering step: call cross-encoder on top-K after hybrid retrieve.
