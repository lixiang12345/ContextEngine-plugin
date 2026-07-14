# Deploy Embedding + Reranker (GPU)

This guide reproduces the **production** setup used for multi-language semantic benchmarks:

| Role | Model | GPU memory (approx) |
|------|--------|---------------------|
| Embedding | `Qwen/Qwen3-Embedding-0.6B` | ~1.1 GB fp16 |
| Reranker | `Qwen/Qwen3-Reranker-0.6B` | ~1.1 GB fp16 |
| **Total** | both loaded | **~2.2–2.5 GB** |

Validated on: **NVIDIA RTX 3080 Ti 12GB**, Ubuntu 22.04, CUDA 12.x, PyTorch 2.9 + cu128, Python 3.12 (conda env).

---

## 1. Machine requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| GPU VRAM | 8 GB | 12 GB+ |
| System RAM | 16 GB | 32 GB |
| Disk (models) | 5 GB free | 10 GB+ |
| Network | HuggingFace or ModelScope access | ModelScope / hf-mirror in CN |

**Not required:** Docker (this guide uses `uvicorn` + `sentence-transformers` / `transformers`).

---

## 2. Environment

```bash
# Example: conda env with CUDA PyTorch already installed
source /usr/local/miniconda3/etc/profile.d/conda.sh   # adjust path
conda activate py312

python -c "import torch; print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0))"

pip install -U \
  "fastapi" \
  "uvicorn[standard]" \
  "sentence-transformers>=2.7.0" \
  "transformers>=4.51.0" \
  "accelerate" \
  "huggingface_hub" \
  "modelscope" \
  "pydantic"
```

---

## 3. Download models

### Option A — ModelScope (often faster in China)

```bash
mkdir -p ~/ce-models/ms
python - <<'PY'
from modelscope import snapshot_download
for mid in ["Qwen/Qwen3-Embedding-0.6B", "Qwen/Qwen3-Reranker-0.6B"]:
    p = snapshot_download(mid, cache_dir="/root/ce-models/ms")  # or ~/ce-models/ms
    print("OK", mid, "->", p)
PY
```

Typical layout after download:

```text
~/ce-models/ms/models/Qwen--Qwen3-Embedding-0.6B/snapshots/master/
~/ce-models/ms/models/Qwen--Qwen3-Reranker-0.6B/snapshots/master/
```

### Option B — Hugging Face

```bash
export HF_HUB_DISABLE_XET=1          # avoid xet 401 issues on some networks
export HF_ENDPOINT=https://hf-mirror.com   # optional CN mirror
huggingface-cli download Qwen/Qwen3-Embedding-0.6B --local-dir ~/ce-models/Qwen3-Embedding-0.6B
huggingface-cli download Qwen/Qwen3-Reranker-0.6B --local-dir ~/ce-models/Qwen3-Reranker-0.6B
```

---

## 4. API server

ContextEngine expects an **OpenAI-compatible** embeddings endpoint:

```http
POST /v1/embeddings
GET  /v1/models
GET  /health
```

Optional (for future / manual use):

```http
POST /v1/rerank
```

### Reference server (in this repo)

Production-tested FastAPI app:

```text
scripts/embed_rerank_server.py
```

**Minimal layout on the GPU machine:**

```text
/root/ce-services/
  server.py          # copy of scripts/embed_rerank_server.py
  logs/server.log
/root/ce-models/ms/models/...
```

**Start (from this repo on the GPU host):**

```bash
source /usr/local/miniconda3/etc/profile.d/conda.sh
conda activate py312

# Optional: deploy a copy under /root/ce-services
mkdir -p /root/ce-services/logs
cp scripts/embed_rerank_server.py /root/ce-services/server.py
cd /root/ce-services

export EMBED_MODEL=/root/ce-models/ms/models/Qwen--Qwen3-Embedding-0.6B/snapshots/master
export RERANK_MODEL=/root/ce-models/ms/models/Qwen--Qwen3-Reranker-0.6B/snapshots/master
export CE_API_KEY=ce-local-key
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

nohup python -m uvicorn server:app --host 0.0.0.0 --port 8000 --workers 1 \
  > logs/server.log 2>&1 &

# Wait until log shows READY / Application startup complete
curl -s http://127.0.0.1:8000/health
```

Or run in-place without copying:

```bash
export EMBED_MODEL=... RERANK_MODEL=... CE_API_KEY=ce-local-key
python -m uvicorn scripts.embed_rerank_server:app --host 0.0.0.0 --port 8000 --workers 1
```
Healthy response example:

```json
{
  "ok": true,
  "device": "cuda",
  "embed_loaded": true,
  "rerank_loaded": true,
  "gpu": "NVIDIA GeForce RTX 3080 Ti",
  "vram_alloc_gb": 2.22
}
```

### Smoke tests

```bash
# Embeddings
curl -s http://127.0.0.1:8000/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"model":"Qwen/Qwen3-Embedding-0.6B","input":"process payment webhook"}' \
  | python -c "import json,sys; d=json.load(sys.stdin); print(len(d['data'][0]['embedding']))"
# expect 1024

# Rerank (Qwen3-Reranker uses yes/no scoring under the hood)
curl -s http://127.0.0.1:8000/v1/rerank \
  -H "Content-Type: application/json" \
  -d '{
    "model":"Qwen/Qwen3-Reranker-0.6B",
    "query":"payment webhook",
    "documents":["stripe charge handler","css button","webhook processPayment"]
  }'
```

---

## 5. Network access from your laptop

### Recommended: SSH tunnel (no public 8000)

```bash
ssh -p 23 -L 18000:127.0.0.1:8000 root@YOUR_GPU_HOST
# then use http://127.0.0.1:18000 as OPENAI_BASE_URL
```

### Optional: public bind

Only if firewall + API key are configured. Prefer reverse proxy with TLS.

---

## 6. Connect ContextEngine

On the machine that runs the CLI / MCP:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:18000/v1   # or http://GPU_HOST:8000/v1
export OPENAI_API_KEY=ce-local-key
export OPENAI_EMBEDDING_MODEL=Qwen/Qwen3-Embedding-0.6B

# Safer defaults on 12GB GPUs
export CONTEXTENGINE_EMBED_BATCH=8
export CONTEXTENGINE_EMBED_MAX_CHARS=3000
# Optional second-stage neural rerank. Enable after the acceptance check below:
# export CONTEXTENGINE_NEURAL_RERANK=1
# export CONTEXTENGINE_RERANK_MODEL=Qwen/Qwen3-Reranker-0.6B

cd /path/to/ContextEngine-plugin
npm run build

# Index a repo (writes vectors into PostgreSQL + pgvector)
node dist/cli.js index /path/to/repo

# Search (auto → hybrid when embeddings exist)
node dist/cli.js search "how does authentication work" --mode auto -k 8

# Self-eval
node dist/cli.js eval --self

# Remote endpoint compatibility: 10 query languages × 10 code languages.
npm run bench:api

# Multi-language suite
npm run bench:multilang
```

### Temporary public tunnels (Colab / TryCloudflare)

Use the current public origin directly; ContextEngine appends `/v1` when necessary:

```bash
export CONTEXTENGINE_EMBEDDING_BASE_URL=https://YOUR_CURRENT_TUNNEL.trycloudflare.com
export CONTEXTENGINE_EMBEDDING_API_KEY=YOUR_CURRENT_API_KEY
export CONTEXTENGINE_EMBEDDING_MODEL=Qwen/Qwen3-Embedding-0.6B
export CONTEXTENGINE_EMBEDDING_INPUT_TYPE=1
# Run the API benchmark before enabling neural rerank in production.
# export CONTEXTENGINE_NEURAL_RERANK=1
# export CONTEXTENGINE_RERANK_MODEL=Qwen/Qwen3-Reranker-0.6B
export CONTEXTENGINE_RERANK_INSTRUCTION='Given a programming task or natural language question about a codebase, retrieve the most relevant source code implementation.'

npm run bench:api
BENCH_SUITES=got-ts,requests-py npm run bench:multilang
```

TryCloudflare origins and Colab runtime credentials change after restart. Keep the
runtime active for a full benchmark, put credentials only in an untracked local `.env`
or shell session, and re-run the API benchmark after every redeploy. Revoke and replace
any Hugging Face token that was ever pasted into chat or a committed file; this
ModelScope deployment does not need that token.

### Rerank acceptance check

`/health` and a `200` from `/v1/rerank` only establish API availability. Before setting
`CONTEXTENGINE_NEURAL_RERANK=1`, run `npm run bench:api` and verify that
`hasMeaningfulScoreSpread` is `true`. If the report shows all rerank scores tied, the
ContextEngine client preserves the existing hybrid order instead of blending in a
non-informative signal; leave neural rerank disabled until the server scoring is fixed.

MCP example:

```bash
export CONTEXTENGINE_ROOT=/path/to/repo
export CONTEXTENGINE_AUTO_INDEX=1
export OPENAI_BASE_URL=http://127.0.0.1:18000/v1
export OPENAI_API_KEY=ce-local-key
export OPENAI_EMBEDDING_MODEL=Qwen/Qwen3-Embedding-0.6B
node /path/to/ContextEngine-plugin/dist/mcp-server.js
```

---

## 7. Operational tips

| Issue | Mitigation |
|-------|------------|
| CUDA OOM during large index | Lower `CONTEXTENGINE_EMBED_BATCH` (8→4→1); restart uvicorn to defrag VRAM |
| Slow HF downloads | Use ModelScope or `HF_ENDPOINT=https://hf-mirror.com`; set `HF_HUB_DISABLE_XET=1` |
| Service dies after reboot | systemd unit or re-run the `nohup uvicorn` block |
| Public exposure | Prefer SSH tunnel; if public, put behind nginx + auth |

### systemd sketch (optional)

```ini
[Unit]
Description=ContextEngine Embed+Rerank
After=network.target

[Service]
Type=simple
WorkingDirectory=/root/ce-services
Environment=EMBED_MODEL=/root/ce-models/ms/models/Qwen--Qwen3-Embedding-0.6B/snapshots/master
Environment=RERANK_MODEL=/root/ce-models/ms/models/Qwen--Qwen3-Reranker-0.6B/snapshots/master
Environment=HF_HUB_OFFLINE=1
Environment=TRANSFORMERS_OFFLINE=1
Environment=PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
ExecStart=/usr/local/miniconda3/envs/py312/bin/python -m uvicorn server:app --host 127.0.0.1 --port 8000 --workers 1
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

---

## 8. What ContextEngine uses today

| Capability | Status |
|------------|--------|
| Dense embeddings for index + search | **Yes** (required for production semantic mode) |
| Query-time instruct prefix | **Yes** (`CODE_RETRIEVAL_QUERY_INSTRUCT`) |
| Neural `/v1/rerank` in search path | **Optional** — set `CONTEXTENGINE_NEURAL_RERANK=1` (blends top-N after hybrid+features; default off so mis-tuned rerankers cannot promote docs over code) |
| Multi-language structural chunking | **Yes** (see `docs/CHUNKING.md`) |

### Enable neural rerank after acceptance (optional second stage)

Requires the same GPU server with `RERANK_MODEL` loaded (or any compatible `/v1/rerank`)
and a passing rerank score-spread check.

```bash
export CONTEXTENGINE_NEURAL_RERANK=1
export CONTEXTENGINE_RERANK_MODEL=Qwen/Qwen3-Reranker-0.6B
# optional overrides (default = same host as embeddings):
# export CONTEXTENGINE_RERANK_BASE_URL=http://127.0.0.1:18000/v1
# export CONTEXTENGINE_RERANK_TOP_N=20
# export CONTEXTENGINE_RERANK_WEIGHT=0.32

contextengine search "how does authentication work" --mode auto
```

Pipeline position: hybrid fuse + feature score → **neural blend on top-N** → graph expand → MMR pack.  
Failures and all-tied score sets are best-effort (falls back to hybrid ranking).

---

## 9. Production bar (multi-lang bench)

With this deployment, the multi-language suite (`npm run bench:multilang`) achieved approximately:

| Metric | Value |
|--------|------:|
| mean **Recall@k** | **~0.996** |
| mean **MRR** | **~0.93** |
| mean **Top1** | **~0.88** |
| mean **Top5** | **~0.98** |

Languages: JavaScript, Go, Python, C, C++, Java, Kotlin, Rust.

See `docs/MULTILANG_BENCH.md` and `eval-results/multilang-summary.json`.
