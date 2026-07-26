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
from hmac import compare_digest
from threading import Lock
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
MAX_EMBED_BATCH = int(os.environ.get("CE_MAX_EMBED_BATCH", "64"))
MAX_RERANK_DOCS = int(os.environ.get("CE_MAX_RERANK_DOCS", "64"))
RERANK_BATCH_SIZE = int(os.environ.get("CE_RERANK_BATCH_SIZE", "8"))
RERANK_MAX_LENGTH = int(os.environ.get("CE_RERANK_MAX_LENGTH", "4096"))
RERANK_INSTRUCTION = os.environ.get(
    "CE_RERANK_INSTRUCTION",
    (
        "Given a programming task or natural language question about a codebase, "
        "retrieve the most relevant source code implementation."
    ),
).strip()
EMBED_REVISION = os.environ.get("EMBED_REVISION", "").strip()
RERANK_REVISION = os.environ.get("RERANK_REVISION", "").strip()

app = FastAPI(title="ContextEngine Embed+Rerank", version="1.0.0")

_embedder = None
_reranker = None
_embed_id = "Qwen/Qwen3-Embedding-0.6B"
_rerank_id = "Qwen/Qwen3-Reranker-0.6B"
_ready = False
_inference_lock = Lock()


def _check_auth(authorization: str | None) -> None:
    if not CE_API_KEY:
        return
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing Bearer token")
    token = authorization[len("Bearer ") :].strip()
    if not compare_digest(token, CE_API_KEY):
        raise HTTPException(status_code=401, detail="Invalid API key")


def _vram_alloc_gb() -> float | None:
    if not torch.cuda.is_available():
        return None
    return round(torch.cuda.memory_allocated() / (1024**3), 2)


@app.on_event("startup")
def load_models() -> None:
    global _embedder, _reranker, _embed_id, _rerank_id, _ready

    from sentence_transformers import CrossEncoder, SentenceTransformer

    print(f"[ce-server] loading embedder: {EMBED_MODEL} on {DEVICE}", flush=True)
    _embedder = SentenceTransformer(
        EMBED_MODEL,
        device=DEVICE,
        revision=EMBED_REVISION or None,
        local_files_only=os.environ.get("HF_HUB_OFFLINE") == "1",
    )
    _embed_id = os.path.basename(EMBED_MODEL.rstrip("/")) or EMBED_MODEL
    if "Qwen3-Embedding" in EMBED_MODEL or "qwen3-embedding" in EMBED_MODEL.lower():
        _embed_id = "Qwen/Qwen3-Embedding-0.6B"
    print(f"[ce-server] embedder ready dim={_embedder.get_sentence_embedding_dimension()}", flush=True)

    if RERANK_MODEL:
        print(f"[ce-server] loading reranker: {RERANK_MODEL} on {DEVICE}", flush=True)
        _reranker = CrossEncoder(
            RERANK_MODEL,
            device=DEVICE,
            trust_remote_code=True,
            revision=RERANK_REVISION or None,
            local_files_only=os.environ.get("HF_HUB_OFFLINE") == "1",
            max_length=RERANK_MAX_LENGTH,
            prompts={"code_retrieval": RERANK_INSTRUCTION},
            default_prompt_name="code_retrieval",
            model_kwargs={
                "torch_dtype": torch.float16 if DEVICE == "cuda" else torch.float32,
            },
        )
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
    instruction: str | None = None


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
        "rerank_loaded": _reranker is not None,
        "gpu": gpu,
        "vram_alloc_gb": _vram_alloc_gb(),
        "embed_model": _embed_id,
        "embed_revision": EMBED_REVISION or None,
        "rerank_model": _rerank_id if _reranker is not None else None,
        "rerank_revision": RERANK_REVISION or None,
        "max_embed_batch": MAX_EMBED_BATCH,
        "max_rerank_docs": MAX_RERANK_DOCS,
    }


@app.get("/v1/models")
def list_models(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    _check_auth(authorization)
    data = [{"id": _embed_id, "object": "model", "owned_by": "local"}]
    if _reranker is not None:
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
    if len(texts) > MAX_EMBED_BATCH:
        raise HTTPException(
            status_code=413,
            detail=f"Embedding batch exceeds configured limit ({MAX_EMBED_BATCH})",
        )
    texts = [(t or "")[:MAX_EMBED_CHARS] for t in texts]
    if not texts:
        return {
            "object": "list",
            "data": [],
            "model": body.model or _embed_id,
            "usage": {"prompt_tokens": 0, "total_tokens": 0},
        }

    # sentence-transformers: normalize for cosine / dot-product retrieval
    with _inference_lock:
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


def _qwen3_rerank_scores(
    query: str,
    documents: list[str],
    instruction: str | None,
) -> list[float]:
    """Score query/document pairs through Sentence Transformers' Qwen3 path.

    CrossEncoder implements the model card's required chat prefix/suffix and
    yes/no logit extraction. The previous hand-written generation prompt scored
    the token before the official non-thinking suffix and could return ties.
    """
    assert _reranker is not None
    pairs = [(query, (doc or "")[:MAX_EMBED_CHARS]) for doc in documents]
    prompt = (instruction or RERANK_INSTRUCTION).strip() or RERANK_INSTRUCTION
    with _inference_lock:
        values = _reranker.predict(
            pairs,
            prompt=prompt,
            batch_size=max(1, RERANK_BATCH_SIZE),
            show_progress_bar=False,
            convert_to_numpy=True,
        )
    raw = values.tolist() if hasattr(values, "tolist") else list(values)
    scores: list[float] = []
    for value in raw:
        while isinstance(value, list) and len(value) == 1:
            value = value[0]
        if isinstance(value, list):
            raise RuntimeError("Reranker returned a non-scalar score")
        scores.append(float(value))
    return scores


@app.post("/v1/rerank")
def rerank(
    body: RerankRequest,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    _check_auth(authorization)
    if _reranker is None:
        raise HTTPException(
            status_code=501,
            detail="Reranker not loaded (set RERANK_MODEL)",
        )
    if len(body.documents or []) > MAX_RERANK_DOCS:
        raise HTTPException(
            status_code=413,
            detail=f"Rerank request exceeds configured limit ({MAX_RERANK_DOCS})",
        )
    docs = body.documents or []
    if not body.query or not docs:
        return {
            "model": body.model or _rerank_id,
            "results": [],
            "usage": {"total_tokens": 0},
        }

    t0 = time.time()
    scores = _qwen3_rerank_scores(body.query, docs, body.instruction)
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
