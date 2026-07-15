#!/usr/bin/env node
/**
 * Remote embedding + rerank compatibility benchmark.
 *
 * Covers code snippets from mainstream programming languages and queries in
 * ten natural languages. This is an API/model smoke benchmark, not a
 * replacement for the real-repository path-gold suite.
 *
 * Run through npm so dist helpers are current:
 *   npm run bench:api
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const outDir = process.env.BENCH_OUT_DIR || path.join(repoRoot, "eval-results");

const apiKey =
  process.env.CONTEXTENGINE_EMBEDDING_API_KEY ||
  process.env.OPENAI_API_KEY ||
  process.env.EMBEDDING_API_KEY;
const embeddingBase =
  process.env.CONTEXTENGINE_EMBEDDING_BASE_URL ||
  process.env.OPENAI_BASE_URL;
const embeddingModel =
  process.env.CONTEXTENGINE_EMBEDDING_MODEL ||
  process.env.OPENAI_EMBEDDING_MODEL ||
  "Qwen/Qwen3-Embedding-0.6B";
const rerankKey =
  process.env.CONTEXTENGINE_RERANK_API_KEY ||
  apiKey;
const rerankBase =
  process.env.CONTEXTENGINE_RERANK_BASE_URL ||
  embeddingBase;
const rerankModel =
  process.env.CONTEXTENGINE_RERANK_MODEL ||
  process.env.OPENAI_RERANK_MODEL ||
  "Qwen/Qwen3-Reranker-0.6B";
const runRerank = process.env.BENCH_RERANK !== "0";
const requireRerank = process.env.BENCH_REQUIRE_RERANK === "1";
const sendInputType = /^(1|true|yes|on)$/i.test(
  (
    process.env.BENCH_EMBED_INPUT_TYPES ||
    process.env.CONTEXTENGINE_EMBEDDING_INPUT_TYPE ||
    ""
  ).trim(),
);
const rerankInstruction =
  process.env.BENCH_RERANK_INSTRUCTION?.trim() ||
  process.env.CONTEXTENGINE_RERANK_INSTRUCTION?.trim();

if (!apiKey || !embeddingBase) {
  console.error(
    "Set CONTEXTENGINE_EMBEDDING_API_KEY (or OPENAI_API_KEY) and CONTEXTENGINE_EMBEDDING_BASE_URL (or OPENAI_BASE_URL).",
  );
  process.exit(2);
}

const { apiOriginFromBaseUrl, normalizeOpenAIBaseUrl, openAIEndpoint } =
  await import(
    pathToFileURL(path.join(repoRoot, "dist/util/api-url.js")).href
  );
const { requestJson } = await import(
  pathToFileURL(path.join(repoRoot, "dist/util/http-json.js")).href
);
const { isEmbeddingReady } = await import(
  pathToFileURL(path.join(repoRoot, "dist/util/model-health.js")).href
);

const queryInstruct =
  process.env.CONTEXTENGINE_EMBED_QUERY_INSTRUCT?.trim() ||
  "Instruct: Given a programming task or natural language question about a codebase, retrieve the most relevant source code implementation.\nQuery: ";

const docs = [
  {
    id: "typescript-auth",
    language: "TypeScript",
    text: `export function requireBearerToken(header: string | undefined) {
  const token = header?.replace(/^Bearer\\s+/i, "");
  if (!token || !verifyAccessToken(token)) throw new UnauthorizedError();
  return token;
}`,
  },
  {
    id: "python-transaction",
    language: "Python",
    text: `def save_order(session, order):
    try:
        session.add(order)
        session.commit()
    except Exception:
        session.rollback()
        raise`,
  },
  {
    id: "go-retry",
    language: "Go",
    text: `func retryRequest(client *http.Client, req *http.Request) (*http.Response, error) {
    for attempt := 0; attempt < 3; attempt++ {
        response, err := client.Do(req)
        if err == nil && response.StatusCode < 500 { return response, nil }
        time.Sleep(backoff(attempt))
    }
    return nil, ErrRetriesExhausted
}`,
  },
  {
    id: "rust-cache",
    language: "Rust",
    text: `fn evict_expired(cache: &mut HashMap<String, Entry>, now: Instant) {
    cache.retain(|_, entry| entry.expires_at > now);
}`,
  },
  {
    id: "java-webhook",
    language: "Java",
    text: `public void handleWebhook(String payload, String signature) {
  webhookVerifier.verify(payload, signature);
  paymentEvents.publish(parseEvent(payload));
}`,
  },
  {
    id: "cpp-image",
    language: "C++",
    text: `Image resizeImage(const Image& input, int width, int height) {
  return resampler.resize(input, width, height, Interpolation::Lanczos);
}`,
  },
  {
    id: "csharp-csv",
    language: "C#",
    text: `public IEnumerable<Row> ParseCsv(Stream stream) {
    using var reader = new StreamReader(stream);
    return reader.ReadToEnd().Split('\\n').Select(ParseRow);
}`,
  },
  {
    id: "ruby-email",
    language: "Ruby",
    text: `def send_receipt_email(user, receipt)
  ReceiptMailer.with(user:, receipt:).deliver_later
end`,
  },
  {
    id: "php-permission",
    language: "PHP",
    text: `function requirePermission(User $user, string $permission): void {
    if (!$user->can($permission)) {
        throw new ForbiddenHttpException();
    }
}`,
  },
  {
    id: "swift-upload",
    language: "Swift",
    text: `func uploadFile(_ file: URL, to endpoint: URL) async throws {
    var request = URLRequest(url: endpoint)
    request.httpMethod = "PUT"
    try await URLSession.shared.upload(for: request, fromFile: file)
}`,
  },
];

const cases = [
  {
    id: "en-auth",
    language: "English",
    query: "Where is a Bearer access token verified before a request is accepted?",
    expected: "typescript-auth",
  },
  {
    id: "zh-transaction",
    language: "Chinese",
    query: "订单保存失败时，在哪里回滚数据库事务？",
    expected: "python-transaction",
  },
  {
    id: "ja-retry",
    language: "Japanese",
    query: "HTTP リクエストが失敗したときに再試行する処理はどこですか？",
    expected: "go-retry",
  },
  {
    id: "ko-cache",
    language: "Korean",
    query: "만료된 캐시 항목을 제거하는 코드는 어디에 있나요?",
    expected: "rust-cache",
  },
  {
    id: "es-webhook",
    language: "Spanish",
    query: "¿Dónde se valida la firma de un webhook de pago?",
    expected: "java-webhook",
  },
  {
    id: "fr-image",
    language: "French",
    query: "Ou redimensionne-t-on une image avec une largeur et une hauteur ?",
    expected: "cpp-image",
  },
  {
    id: "de-csv",
    language: "German",
    query: "Wo werden CSV-Zeilen aus einem Stream eingelesen und geparst?",
    expected: "csharp-csv",
  },
  {
    id: "pt-email",
    language: "Portuguese",
    query: "Onde o email de recibo e enviado para o usuario?",
    expected: "ruby-email",
  },
  {
    id: "ar-permission",
    language: "Arabic",
    query: "اين يتم التحقق من صلاحية المستخدم قبل السماح بالوصول؟",
    expected: "php-permission",
  },
  {
    id: "hi-upload",
    language: "Hindi",
    query: "फाइल को HTTP PUT के जरिए सर्वर पर अपलोड करने वाला कोड कहां है?",
    expected: "swift-upload",
  },
];

function normalize(vector) {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return vector.map((value) => value / (norm || 1));
}

function cosine(a, b) {
  return a.reduce((sum, value, index) => sum + value * b[index], 0);
}

function validateVectors(data, expectedCount, label) {
  if (!Array.isArray(data) || data.length !== expectedCount) {
    throw new Error(`${label} returned ${data?.length ?? 0} vectors for ${expectedCount} inputs`);
  }
  const ordered = [...data].sort((a, b) => a.index - b.index);
  const dimensions = ordered[0]?.embedding?.length ?? 0;
  if (!dimensions) throw new Error(`${label} returned an empty vector`);
  for (const [index, row] of ordered.entries()) {
    if (
      row.index !== index ||
      !Array.isArray(row.embedding) ||
      row.embedding.length !== dimensions ||
      row.embedding.some((value) => !Number.isFinite(value))
    ) {
      throw new Error(`${label} returned an invalid vector at index ${index}`);
    }
  }
  return ordered.map((row) => normalize(row.embedding));
}

function prefixedQuery(query) {
  return /\s$/.test(queryInstruct)
    ? `${queryInstruct}${query}`
    : `${queryInstruct}\n${query}`;
}

async function embed(inputs, label, inputType) {
  const t0 = performance.now();
  const json = await requestJson(
    openAIEndpoint(normalizeOpenAIBaseUrl(embeddingBase), "embeddings"),
    {
      label,
      apiKey,
      body: {
        model: embeddingModel,
        input: inputs,
        ...(sendInputType ? { input_type: inputType } : {}),
      },
    },
  );
  return {
    vectors: validateVectors(json.data, inputs.length, label),
    latencyMs: Math.round(performance.now() - t0),
  };
}

async function preflight() {
  const origin = apiOriginFromBaseUrl(embeddingBase);
  const health = await requestJson(`${origin}/health`, {
    label: "Model health check",
    timeoutMs: 15_000,
    retries: 0,
  });
  if (!isEmbeddingReady(health)) {
    throw new Error("Model health check did not report a loaded embedder");
  }
  return health;
}

const embeddingApiBase = normalizeOpenAIBaseUrl(embeddingBase);
console.log(`Embedding endpoint: ${embeddingApiBase}`);
console.log(`Embedding model: ${embeddingModel}`);

let health;
try {
  health = await preflight();
} catch (error) {
  console.error(`Remote preflight failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const documentEmbeddings = await embed(
  docs.map((doc) => doc.text),
  "Embedding document benchmark",
  "document",
);
const queryEmbeddings = await embed(
  cases.map((item) => prefixedQuery(item.query)),
  "Embedding query benchmark",
  "query",
);
const embeddingRows = cases.map((item, index) => {
  const ranking = docs
    .map((doc, docIndex) => ({
      id: doc.id,
      score: cosine(queryEmbeddings.vectors[index], documentEmbeddings.vectors[docIndex]),
    }))
    .sort((a, b) => b.score - a.score);
  return {
    id: item.id,
    language: item.language,
    expected: item.expected,
    top1: ranking[0].id,
    top3: ranking.slice(0, 3).map((row) => row.id),
    successTop1: ranking[0].id === item.expected,
  };
});

let rerank = {
  requested: runRerank,
  available: false,
  cases: [],
};
if (runRerank) {
  try {
    const rerankRows = [];
    for (const item of cases) {
      const t0 = performance.now();
      const json = await requestJson(
        openAIEndpoint(normalizeOpenAIBaseUrl(rerankBase), "rerank"),
        {
          label: "Rerank benchmark",
          apiKey: rerankKey,
          body: {
            model: rerankModel,
            query: item.query,
            documents: docs.map((doc) => doc.text),
            top_n: docs.length,
            ...(rerankInstruction ? { instruction: rerankInstruction } : {}),
          },
        },
      );
      const rows = Array.isArray(json.results) ? json.results : [];
      const ranking = rows
        .filter((row) => Number.isInteger(row.index) && row.index >= 0 && row.index < docs.length)
        .sort((a, b) => (b.relevance_score ?? b.score ?? 0) - (a.relevance_score ?? a.score ?? 0));
      if (!ranking.length) throw new Error("Rerank benchmark returned no valid results");
      const scores = ranking
        .map((row) => row.relevance_score ?? row.score)
        .filter((score) => typeof score === "number" && Number.isFinite(score));
      const scoreRange = scores.length
        ? Math.max(...scores) - Math.min(...scores)
        : null;
      const top1 = docs[ranking[0].index].id;
      rerankRows.push({
        id: item.id,
        language: item.language,
        expected: item.expected,
        top1,
        top3: ranking.slice(0, 3).map((row) => docs[row.index].id),
        successTop1: top1 === item.expected,
        latencyMs: Math.round(performance.now() - t0),
        topScore: scores[0] ?? null,
        scoreRange,
        scoresTied: scoreRange !== null && scoreRange <= 1e-9,
      });
    }
    rerank = {
      requested: true,
      available: true,
      cases: rerankRows,
    };
  } catch (error) {
    rerank = {
      requested: true,
      available: false,
      error: error instanceof Error ? error.message : String(error),
      cases: [],
    };
    if (requireRerank) {
      console.error(`Rerank benchmark failed: ${rerank.error}`);
      process.exit(2);
    }
  }
}

const out = {
  meta: {
    note: "Remote API compatibility benchmark. It checks multilingual query-to-code matching, not full-repository retrieval quality.",
    endpointHost: new URL(apiOriginFromBaseUrl(embeddingBase)).host,
    evaluatedAt: new Date().toISOString(),
    health,
  },
  embedding: {
    model: embeddingModel,
    dimensions: documentEmbeddings.vectors[0].length,
    inputTypes: sendInputType,
    documentLatencyMs: documentEmbeddings.latencyMs,
    queryLatencyMs: queryEmbeddings.latencyMs,
    top1Accuracy:
      embeddingRows.filter((row) => row.successTop1).length / embeddingRows.length,
    cases: embeddingRows,
  },
  rerank: {
    ...rerank,
    model: runRerank ? rerankModel : null,
    instruction: rerankInstruction || null,
    top1Accuracy: rerank.available
      ? rerank.cases.filter((row) => row.successTop1).length / rerank.cases.length
      : null,
    tiedScoreCases: rerank.available
      ? rerank.cases.filter((row) => row.scoresTied).length
      : null,
    hasMeaningfulScoreSpread: rerank.available
      ? rerank.cases.some((row) => !row.scoresTied)
      : null,
  },
};

mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "api-multilingual-summary.json");
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log("\n======== API BENCH ========");
console.log(
  JSON.stringify(
    {
      embeddingTop1: out.embedding.top1Accuracy,
      rerankAvailable: out.rerank.available,
      rerankTop1: out.rerank.top1Accuracy,
      rerankTiedScoreCases: out.rerank.tiedScoreCases,
      embeddingDimensions: out.embedding.dimensions,
    },
    null,
    2,
  ),
);
console.log(`Wrote ${outPath}`);
