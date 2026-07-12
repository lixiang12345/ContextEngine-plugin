#!/usr/bin/env python3
"""
OpenAI-compatible embedding (+ optional Qwen3 rerank) server for ContextEngine.

Validated layout (see docs/DEPLOY_EMBED_RERANK.md):

  export EMBED_MODEL=/path/to/Qwen3-Embedding-0.6B
  export RERANK_MODEL=/path/to/Qwen3-Reranker-0.6B   # optional
  export CE_API_KEY=ce-local-key
  uvicorn scripts.embed_rerank_server:app --host 0.0.0.0 --port 8000 --workers 1

Or copy this file to /root/ce-services/server.py and run:
  uvicorn server:app --host 0.0.0.0 --port 8000 --workers 1
"""

from __future__ import annotations

import os
import time
from typing import Any

import torch
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

EMBED_MODEL = os.environ.get("EMBED_MODEL", "Qwen/Qwen3-Embedding-0.6B")
RERANK_MODEL = os.environ.get("RERANK_MODEL", "").strip()
CE_API_KEY = os.environ.get("CE_API_KEY", "").strip()
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
MAX_EMBED_CHARS = int(os.environ.get("CE_MAX_EMBED_CHARS", "8000"))
MAX_RERANK_DOCS = int(os.environ.get("CE_MAX_RERANK_DOCS", "64"))

app = FastAPI(title="ContextEngine Embed+Rerank", version="1.0.0")

_embedder = None
_reranker_tok = None
_reranker_model = None
_embed_id = "Qwen/Qwen3-Embedding-0.6B"
_rerank_id = "Qwen/Qwen3-Reranker-0.6B"
_ready = False


def _check_auth(authorization: str | None) -> None:
    if not CE_API_KEY:
        return
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing Bearer token")
    token = authorization[len("Bearer ") :].strip()
    if token != CE_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")


def _vram_alloc_gb() -> float | None:
    if not torch.cuda.is_available():
        return None
    return round(torch.cuda.memory_allocated() / (1024**3), 2)


@app.on_event("startup")
def load_models() -> None:
    global _embedder, _reranker_tok, _reranker_model, _embed_id, _rerank_id, _ready

    from sentence_transformers import SentenceTransformer

    print(f"[ce-server] loading embedder: {EMBED_MODEL} on {DEVICE}", flush=True)
    _embedder = SentenceTransformer(EMBED_MODEL, device=DEVICE)
    _embed_id = os.path.basename(EMBED_MODEL.rstrip("/")) or EMBED_MODEL
    if "Qwen3-Embedding" in EMBED_MODEL or "qwen3-embedding" in EMBED_MODEL.lower():
        _embed_id = "Qwen/Qwen3-Embedding-0.6B"
    print(f"[ce-server] embedder ready dim={_embedder.get_sentence_embedding_dimension()}", flush=True)

    if RERANK_MODEL:
        from transformers import AutoModelForCausalLM, AutoTokenizer

        print(f"[ce-server] loading reranker: {RERANK_MODEL} on {DEVICE}", flush=True)
        _reranker_tok = AutoTokenizer.from_pretrained(RERANK_MODEL, trust_remote_code=True)
        _reranker_model = AutoModelForCausalLM.from_pretrained(
            RERANK_MODEL,
            torch_dtype=torch.float16 if DEVICE == "cuda" else torch.float32,
            trust_remote_code=True,
        ).to(DEVICE)
        _reranker_model.eval()
        _rerank_id = os.path.basename(RERANK_MODEL.rstrip("/")) or RERANK_MODEL
        if "Qwen3-Reranker" in RERANK_MODEL or "qwen3-reranker" in RERANK_MODEL.lower():
            _rerank_id = "Qwen/Qwen3-Reranker-0.6B"
        print("[ce-server] reranker ready", flush=True)
    else:
        print("[ce-server] RERANK_MODEL not set — /v1/rerank disabled", flush=True)

    _ready = True
    print("[ce-server] READY", flush=True)


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class EmbedRequest(BaseModel):
    model: str | None = None
    input: str | list[str]
    dimensions: int | None = None


class RerankRequest(BaseModel):
    model: str | None = None
    query: str
    documents: list[str] = Field(default_factory=list)
    top_n: int | None = None


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/health")
def health() -> dict[str, Any]:
    gpu = None
    if torch.cuda.is_available():
        try:
            gpu = torch.cuda.get_device_name(0)
        except Exception:
            gpu = "cuda"
    return {
        "ok": _ready,
        "device": DEVICE,
        "embed_loaded": _embedder is not None,
        "rerank_loaded": _reranker_model is not None,
        "gpu": gpu,
        "vram_alloc_gb": _vram_alloc_gb(),
    }


@app.get("/v1/models")
def list_models(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    _check_auth(authorization)
    data = [{"id": _embed_id, "object": "model", "owned_by": "local"}]
    if _reranker_model is not None:
        data.append({"id": _rerank_id, "object": "model", "owned_by": "local"})
    return {"object": "list", "data": data}


@app.post("/v1/embeddings")
def embeddings(
    body: EmbedRequest,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    _check_auth(authorization)
    if _embedder is None:
        raise HTTPException(status_code=503, detail="Embedder not loaded")

    texts = body.input if isinstance(body.input, list) else [body.input]
    texts = [(t or "")[:MAX_EMBED_CHARS] for t in texts]
    if not texts:
        return {
            "object": "list",
            "data": [],
            "model": body.model or _embed_id,
            "usage": {"prompt_tokens": 0, "total_tokens": 0},
        }

    # sentence-transformers: normalize for cosine / dot-product retrieval
    vectors = _embedder.encode(
        texts,
        convert_to_numpy=True,
        normalize_embeddings=True,
        show_progress_bar=False,
    )

    data = []
    for i, vec in enumerate(vectors):
        emb = vec.tolist()
        if body.dimensions and body.dimensions > 0:
            emb = emb[: body.dimensions]
        data.append({"object": "embedding", "index": i, "embedding": emb})

    return {
        "object": "list",
        "data": data,
        "model": body.model or _embed_id,
        "usage": {
            "prompt_tokens": sum(max(1, len(t) // 4) for t in texts),
            "total_tokens": sum(max(1, len(t) // 4) for t in texts),
        },
    }


def _qwen3_rerank_scores(query: str, documents: list[str]) -> list[float]:
    """Qwen3-Reranker yes/no logprob scoring (official prompt pattern)."""
    assert _reranker_tok is not None and _reranker_model is not None

    # Keep prompt close to Qwen3-Reranker model card.
    system = (
        "Judge whether the Document meets the requirements based on the Query "
        "and the Instruct provided. Note that the answer can only be \"yes\" or \"no\"."
    )
    instruct = (
        "Given a programming task or natural language question about a codebase, "
        "retrieve the most relevant source code implementation."
    )
    yes_id = _reranker_tok.convert_tokens_to_ids("yes")
    no_id = _reranker_tok.convert_tokens_to_ids("no")
    scores: list[float] = []

    for doc in documents:
        doc = (doc or "")[:MAX_EMBED_CHARS]
        user = (
            f"<Instruct>: {instruct}\n"
            f"<Query>: {query}\n"
            f"<Document>: {doc}"
        )
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]
        try:
            text = _reranker_tok.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
            )
        except Exception:
            text = f"{system}\n\n{user}\n"

        inputs = _reranker_tok(
            text,
            return_tensors="pt",
            truncation=True,
            max_length=2048,
        ).to(DEVICE)

        with torch.no_grad():
            out = _reranker_model(**inputs)
            logits = out.logits[0, -1, :]
            pair = torch.stack([logits[no_id], logits[yes_id]])
            probs = torch.softmax(pair.float(), dim=0)
            scores.append(float(probs[1].item()))

    return scores


@app.post("/v1/rerank")
def rerank(
    body: RerankRequest,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    _check_auth(authorization)
    if _reranker_model is None:
        raise HTTPException(
            status_code=501,
            detail="Reranker not loaded (set RERANK_MODEL)",
        )
    docs = (body.documents or [])[:MAX_RERANK_DOCS]
    if not body.query or not docs:
        return {
            "model": body.model or _rerank_id,
            "results": [],
            "usage": {"total_tokens": 0},
        }

    t0 = time.time()
    scores = _qwen3_rerank_scores(body.query, docs)
    ranked = sorted(
        [{"index": i, "relevance_score": s, "document": docs[i]} for i, s in enumerate(scores)],
        key=lambda r: r["relevance_score"],
        reverse=True,
    )
    if body.top_n is not None and body.top_n > 0:
        ranked = ranked[: body.top_n]

    return {
        "model": body.model or _rerank_id,
        "results": ranked,
        "usage": {
            "total_tokens": sum(max(1, len(d) // 4) for d in docs),
            "latency_ms": int((time.time() - t0) * 1000),
        },
    }


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("CE_HOST", "0.0.0.0")
    port = int(os.environ.get("CE_PORT", "8000"))
    uvicorn.run(app, host=host, port=port, workers=1)
