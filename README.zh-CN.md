# ContextEngine Plugin

**面向 AI 编程 Agent 的可移植、Augment 级代码库上下文引擎。**

多信号检索（PostgreSQL FTS + 符号 + 路径 + pgvector + 图扩展 + MMR），让 Agent 少花 token 乱 grep，多花回合改对代码。

设计说明：[ARCHITECTURE.md](./ARCHITECTURE.md) · 与 Augment 的诚实对比：[COMPARISON.md](./COMPARISON.md) · [深度对齐审计](./docs/AUGMENT_ALIGNMENT.md)

**English:** [README.md](./README.md)

**第一次用？** 按你的环境选路径：

| 路径 | 文档 |
|------|------|
| 仅 BM25 / 云端 Embed / 自建 GPU | **[docs/GETTING_STARTED.md](./docs/GETTING_STARTED.md)** |
| GPU 运维（Qwen3 embed + rerank） | [docs/DEPLOY_EMBED_RERANK.md](./docs/DEPLOY_EMBED_RERANK.md) |
| 多语言 IR 指标 | [docs/MULTILANG_BENCH.md](./docs/MULTILANG_BENCH.md) |
| 远端 IDE / HTTP 同步 API | [docs/HTTP_API.md](./docs/HTTP_API.md) |

```bash
# 建索引
npx contextengine-plugin index

# 搜索
npx contextengine-plugin search "stripe payment webhook"

# 为任务打包上下文
npx contextengine-plugin context "Add logging to payment requests"
```

---

## 为什么需要它

多数编程 Agent 靠反复 `grep` / `find` 摸索大仓库，既费 token，又容易漏掉真正相关的文件。

**ContextEngine** 是一层小而完整的检索组件：

| 能力 | 状态 |
|------|------|
| 查询理解 | 意图 + 标识符 / 路径抽取 |
| 词法检索 | PostgreSQL `tsvector` + GIN（可扩展） |
| 符号检索 | 精确 / 前缀符号表 |
| 语义检索 | 可选 Embeddings，候选上的 **两阶段** 打分 |
| 融合 + 重排 | RRF + 代码感知特征打分 |
| 多样性打包 | 按路径 MMR，受 token 预算约束 |
| 符号 / import 图 | 扩展相关文件 |
| 多根目录 | 代码 + 文档 / 额外仓库同一索引 |
| 提交血缘 | 近期 git 历史块 |
| Watch 模式 | 防抖增量重建索引 |
| MCP | 主工具 `codebase-retrieval`（兼容 Augment；`codebase_retrieval` 为旧别名）+ 搜索 / 文件 / 索引 |
| HTTP | 带鉴权的工作区同步、索引任务、检索与 SSE 进度 |
| Source 插件 | Provider-neutral 只读 Connector SDK；内置 GitHub + GitLab + Bitbucket + 静态网站 |
| 评测 | Recall/MRR/nDCG + 重复成对 PR 运行 + 固定历史 corpus |

**与 Augment 的对比：** [COMPARISON.md](./COMPARISON.md) · **架构：** [ARCHITECTURE.md](./ARCHITECTURE.md)

---

## 安装

### 环境要求

- **Node.js ≥ 22.5**
- **带 pgvector 的 PostgreSQL**（仓库提供本地 Compose）

### 从源码安装（本仓库）

```bash
git clone https://github.com/lixiang12345/ContextEngine-plugin.git
cd ContextEngine-plugin
npm install
npm run build
npm link   # 可选：全局暴露 contextengine 命令
```

### 作为库使用

```bash
npm install contextengine-plugin
```

```ts
import { ContextEngine } from "contextengine-plugin";

const engine = ContextEngine.open({ root: process.cwd() });
await engine.index();
const hits = await engine.search({ query: "auth middleware" });
```

---

## 快速开始

### 1. 为工作区建索引

```bash
# 在本仓库先启动一次本地 pgvector：
npm run db:up
export CONTEXTENGINE_DATABASE_URL=postgresql://contextengine:contextengine@127.0.0.1:54329/contextengine

contextengine index
# 或
contextengine index /path/to/repo
```

索引保存在 PostgreSQL。工作区绝对根路径是命名空间，因此同一个数据库可以容纳多个仓库，运行时也不会把全量向量加载进 Node 内存。

`data-dir` 只保留给一次性的旧 SQLite 索引迁移使用。

### 2. 搜索

```bash
contextengine search "how is rate limiting implemented"
contextengine search "processPayment" --mode bm25 -k 5
```

### 3. 为 Agent 打包上下文

```bash
contextengine context "Add retry logic to the payment webhook"
```

### 4. 查看状态

```bash
contextengine status
```

---

## 语义搜索（可选）

没有 API Key 时，ContextEngine 运行在 **仅 BM25** 模式（仍然有用）。

接入 OpenAI 兼容的 Embeddings 端点：

```bash
export OPENAI_API_KEY=sk-...
# 可选覆盖：
export OPENAI_BASE_URL=https://api.openai.com/v1
export OPENAI_EMBEDDING_MODEL=text-embedding-3-small

contextengine index   # 为新增/变更的 chunk 写向量
contextengine search "checkout timeout" --mode hybrid
```

也支持：

- `CONTEXTENGINE_EMBEDDING_API_KEY`
- `CONTEXTENGINE_EMBEDDING_BASE_URL`
- `CONTEXTENGINE_EMBEDDING_MODEL`

兼容 OpenAI、各类代理，以及提供 `/v1/embeddings` 的本地服务（如 Ollama 兼容网关）。
Base URL 可以填写根地址（如 `https://gateway.example.com`）或带版本的地址
（`https://gateway.example.com/v1`）；ContextEngine 会统一为 `/v1`。

### 自建 GPU 上的 Qwen3（生产路径）

多语言语义检索验证栈（约 2.2 GB 显存）：

| 角色 | 模型 |
|------|------|
| Embedding | `Qwen/Qwen3-Embedding-0.6B` |
| Reranker（可选 API） | `Qwen/Qwen3-Reranker-0.6B` |

```bash
# GPU 机器上 — 完整指南见
# docs/DEPLOY_EMBED_RERANK.md  +  scripts/embed_rerank_server.py

# 笔记本上（SSH 隧道）：
export OPENAI_BASE_URL=http://127.0.0.1:18000/v1
export OPENAI_API_KEY=ce-local-key
export OPENAI_EMBEDDING_MODEL=Qwen/Qwen3-Embedding-0.6B
export CONTEXTENGINE_EMBED_BATCH=8
# 可选：在搜索中启用已部署的 /v1/rerank 二阶段。
# export CONTEXTENGINE_NEURAL_RERANK=1
# export CONTEXTENGINE_RERANK_MODEL=Qwen/Qwen3-Reranker-0.6B
contextengine index
```

**部署指南：** [docs/DEPLOY_EMBED_RERANK.md](./docs/DEPLOY_EMBED_RERANK.md)  
**多语言基准（Top5≈0.98，MRR≈0.93）：** [docs/MULTILANG_BENCH.md](./docs/MULTILANG_BENCH.md)

---

## MCP 集成

ContextEngine 通过 stdio 提供 **Model Context Protocol**。

### Claude Code

```bash
claude mcp add contextengine -- node /absolute/path/to/ContextEngine-plugin/dist/mcp-server.js
```

或在 `npm link` 之后：

```bash
claude mcp add contextengine -- contextengine-mcp
```

环境变量（可选）：

```bash
export CONTEXTENGINE_ROOT=/path/to/repo
export CONTEXTENGINE_AUTO_INDEX=1
# MCP watcher 默认开启；设为 0 可关闭
export CONTEXTENGINE_MCP_WATCH=1
# 可选：逗号分隔的 name:path 根目录，例如 docs:/path/to/docs
export CONTEXTENGINE_EXTRA_ROOTS=docs:/path/to/docs
export OPENAI_API_KEY=...
```

### Cursor / 其他 MCP 客户端

配置 MCP server：

```text
command: node
args: ["/absolute/path/to/ContextEngine-plugin/dist/mcp-server.js"]
```

将 `cwd` 设为要索引的工作区（或设置 `CONTEXTENGINE_ROOT`）。

完整示例见：

- [examples/claude-code.mcp.json](./examples/claude-code.mcp.json)
- [examples/cursor.mcp.json](./examples/cursor.mcp.json)

### 暴露的工具

| 工具 | 用途 |
|------|------|
| `codebase-retrieval` / `codebase_retrieval` | Augment 兼容的上下文打包检索（优先调用） |
| `codebase_search` | 混合搜索 → 路径、行号、符号、内容 |
| `get_task_context` | 在 token 预算下打包排序后的代码块 |
| `get_file_context` | 读取文件 / 行范围 |
| `index_status` | 索引统计 |
| `reindex_workspace` | 增量重建索引 |

**Agent 建议：** 先调 `get_task_context` 再改代码；后续追问用 `codebase_search`。

---

## HTTP 服务

同一套检索内核也能以带鉴权的 HTTP 服务提供给远端 IDE。源文件通过
PostgreSQL 中的内容寻址 Blob 存储；客户端仅同步变更文件的哈希，提交工作区
版本后等待后台索引任务，再执行检索。

```bash
export CONTEXTENGINE_DATABASE_URL=postgresql://contextengine:contextengine@127.0.0.1:54329/contextengine
export CONTEXTENGINE_HTTP_API_KEY="$(openssl rand -base64 32)"

contextengine-http
# GET /health, GET /openapi.json
# 控制台：http://127.0.0.1:8787/dashboard
# 所有 /v1 路由使用 Authorization: Bearer <key>
```

### Docker Compose 部署

仓库内置多阶段生产镜像，以及包含 ContextEngine 和 PostgreSQL/pgvector
的完整 Compose 配置：

```bash
export CONTEXTENGINE_HTTP_API_KEY="$(openssl rand -base64 32)"
docker compose up -d --build
docker compose ps
```

控制台默认发布在 `http://127.0.0.1:8790/dashboard`，主机绑定默认仅限回环地址。
只有可信远程部署才应设置 `CONTEXTENGINE_DOCKER_HTTP_BIND_HOST=0.0.0.0`。
`.env` 中的 Embedding 和 Rerank 配置会透传到应用容器。PostgreSQL 与 HTTP 运行目录
使用命名卷，普通的 `docker compose down` 不会删除索引数据；只有明确需要
清空数据库和运行数据时才使用 `docker compose down -v`。

### 可观测控制台

HTTP 服务内置 `/dashboard` 可观测控制台，与 `/v1/*` 共用 Bearer API Key，
无需单独构建或部署前端。控制台展示：

- 工作区版本、已索引文件数、切片数与向量状态
- 最近索引任务及执行进度
- 请求量、错误率、平均延迟和各路由 P95 延迟
- 进程运行时间与内存占用
- 面向已索引工作区的实时检索探针

请求观测只记录方法、归一化路由、状态码和耗时，不采集查询文本、源码内容、
请求正文或 API Key。控制台通过同源 `GET /v1/observability/overview` 自动刷新。

核心接口包括工作区创建/查询、`/sync/plan`、`PUT /blobs/{sha256}`、
`/sync/commit`、`/index-jobs`、`/search`、`/context` 与 `/file`。

多 Principal Bearer Key 或经过验证的 OAuth/OIDC JWT Access Token 可按工作区实施
`reader`、`writer`、`owner` 权限。OIDC Principal 在 Token 轮换后保持稳定，只有
服务端明确配置的用户组映射才能授予 Operator 权限。Owner 还可以配置默认
allow/deny 与嵌套路径前缀规则；Search、Context、File Read 和 Remote MCP 共用同一
套数据面策略。
只读 GitHub、GitLab 与静态网站 Connector 可将外部内容绑定到空 Blob 工作区并进行增量
同步。网站抓取器强制 HTTPS/公网、同源、路径前缀、robots、重定向、页面数、深度与
字节上限。经过签名验证的 GitHub/GitLab Push Webhook 可通过持久、幂等的事件 inbox 触发
同一套带租约同步流程。配置方式见 `CONTEXTENGINE_HTTP_API_KEYS`、
`CONTEXTENGINE_OIDC_ISSUER`、`CONTEXTENGINE_GITHUB_TOKEN`、
`CONTEXTENGINE_GITHUB_WEBHOOK_SECRET`、`CONTEXTENGINE_GITLAB_TOKEN`、
`CONTEXTENGINE_GITLAB_WEBHOOK_SIGNING_TOKEN`、`CONTEXTENGINE_BITBUCKET_TOKEN`、
`CONTEXTENGINE_WEBSITE_TIMEOUT_MS` 和 HTTP API 文档中的
认证、Connector/ACL 路由。
宿主可以通过 `connectorPlugins` 注册其他来源，详见
[docs/PLUGINS.md](./docs/PLUGINS.md)。
Source 级 CI Trigger Token 可让 GitHub Actions、GitLab CI 与 Bitbucket Pipelines
只刷新指定来源而无需拿到工作区级 API Key，详见 [docs/HTTP_API.md](./docs/HTTP_API.md)
中的 CI Trigger 小节。
活动索引 generation 还可以通过版本化、checksum 校验的 filesystem 或 S3-compatible
快照共享，详见 [docs/SNAPSHOTS.md](./docs/SNAPSHOTS.md)。
配置 `CONTEXTENGINE_SNAPSHOT_STORE` 后，HTTP 服务也会提供同一套 owner 管理操作；
导出、导入、prune 和 GC 返回 PostgreSQL 持久 job，可轮询状态或订阅 SSE，CLI 仍保持同步语义。
配置 `CONTEXTENGINE_SNAPSHOT_REPLICATION_TARGETS` 或注入目标 store 后，owner 还可以异步触发跨区域复制。
复制失败会按有界指数退避自动重试，超过上限后才进入终态失败。

完整的客户端协议、入参出参、SSE 索引进度以及已检查 IntelliJ 插件的适配映射
见 [docs/HTTP_API.md](./docs/HTTP_API.md)。

---

## CLI 参考

```text
contextengine index [root] [--quiet]
contextengine search <query> [-k N] [--mode auto|bm25|semantic|hybrid] [--path-prefix p] [--json]
contextengine context <task> [--max-tokens N] [--json]
contextengine status
contextengine clear-index
contextengine migrate-sqlite <legacy-index.db>
contextengine watch [root] [--debounce 800]   # 实时重建索引
contextengine serve [--auto-index]            # MCP stdio
contextengine http [--host 127.0.0.1] [--port 8787]  # 带鉴权 HTTP 服务
contextengine ci-template <github|gitlab|bitbucket>  # 输出可安装 CI workflow
contextengine snapshot export|import|list|delete|prune|gc [name] [--store path|s3://bucket/prefix]
contextengine eval [--self | --cases file.json] [--reindex]
contextengine profile list|add|use …
```

### 检索输出

ContextEngine 与模型无关。它只负责召回、重排、去重和证据格式化，不识别
模型名称或上下文窗口。默认返回 `topK` 选中的全部命中；调用方只有在明确
需要缩小传输内容时，才传入 `maxTokens` / `max_tokens`。

MCP server 默认监听主工作区和 `CONTEXTENGINE_EXTRA_ROOTS` 配置的额外根目录，
对文件变更做防抖增量索引并刷新检索器。设置 `CONTEXTENGINE_MCP_WATCH=0`
（也支持 `false`、`off`、`no`）可关闭 watcher；关闭后，缺少索引时是否在
首次 MCP 请求自动建立由 `CONTEXTENGINE_AUTO_INDEX=1` 控制。

---

## 配置

| 环境变量 | 含义 |
|----------|------|
| `CONTEXTENGINE_DATABASE_URL` / `DATABASE_URL` | **必填** PostgreSQL 连接串；自动启用 pgvector |
| `CONTEXTENGINE_ROOT` | MCP 使用的工作区根目录 |
| `CONTEXTENGINE_EXTRA_ROOTS` | 可选的逗号分隔 `name:path` 根目录，会一起索引和监听 |
| `CONTEXTENGINE_DATA_DIR` | 仅由 `migrate-sqlite` 用于旧 SQLite 目录 |
| `CONTEXTENGINE_AUTO_INDEX` | `1` = MCP 首次使用时若无索引则自动建 |
| `CONTEXTENGINE_MCP_WATCH` | MCP 文件 watcher；默认开启，设为 `0` / `false` 关闭 |
| `CONTEXTENGINE_HTTP_API_KEY` | HTTP 服务必填 Bearer 密钥 |
| `CONTEXTENGINE_HTTP_HOST` / `_PORT` | HTTP 监听地址和端口 |
| `CONTEXTENGINE_HTTP_MAX_BLOB_BYTES` | 单个同步源 Blob 最大字节数（默认 2 MiB） |
| `CONTEXTENGINE_HTTP_CORS_ORIGINS` | 精确的逗号分隔浏览器 origin，或 `*`；默认关闭 |
| `CONTEXTENGINE_MCP_SESSION_STORE` | `postgres`（默认，跨实例）或 `memory`（单进程回滚模式） |
| `CONTEXTENGINE_MCP_SESSION_IDLE_TTL_MS` | 远程 MCP 空闲会话保留时间（默认 30 分钟） |
| `CONTEXTENGINE_MCP_MAX_SESSIONS` | PostgreSQL 远程 MCP 全局会话上限（默认 128；memory 模式为每进程） |
| `CONTEXTENGINE_HTTP_ALLOW_LOCAL_WORKSPACES` | 允许服务器本地路径工作区（默认关闭） |
| `CONTEXTENGINE_HTTP_ALLOW_PRIVATE_MODEL_URLS` | 允许运行时配置私网/本地模型地址，仅用于可信部署（默认关闭） |
| `CONTEXTENGINE_COMMIT_LIMIT` | 索引的近期 commit 数量（默认 `80`，`0` = 关闭） |
| `CONTEXTENGINE_SEARCH_SEMANTIC_TIMEOUT_MS` / `_RERANK_TIMEOUT_MS` | 单次查询模型预算（默认 `2000` ms），超时自动回退词法检索 |
| `CONTEXTENGINE_SEARCH_BREAKER_FAILURE_THRESHOLD` / `_COOLDOWN_MS` | 模型熔断阈值 / 冷却时间（默认 `3` / `30000` ms） |
| `OPENAI_API_KEY` / `CONTEXTENGINE_EMBEDDING_API_KEY` | 启用 embeddings |
| `OPENAI_BASE_URL` / `CONTEXTENGINE_EMBEDDING_BASE_URL` | Embeddings API 基址 |
| `OPENAI_EMBEDDING_MODEL` / `CONTEXTENGINE_EMBEDDING_MODEL` | 模型名 |
| `CONTEXTENGINE_EMBED_BATCH` | Embed 批大小（默认 `8`） |
| `CONTEXTENGINE_EMBED_MAX_CHARS` | Embed 前截断 chunk 文本 |
| `CONTEXTENGINE_NEURAL_RERANK` | `1` = 开启可选 neural `/v1/rerank` 二阶段 |
| `CONTEXTENGINE_RERANK_MODEL` | Rerank 模型 id（默认 `Qwen/Qwen3-Reranker-0.6B`） |
| `CONTEXTENGINE_RERANK_BASE_URL` | Rerank API 基址（默认与 embed 相同） |
| `CONTEXTENGINE_RERANK_TOP_N` | 送入 reranker 的候选数（默认 `20`） |
| `CONTEXTENGINE_RERANK_WEIGHT` | 混入最终分的权重（默认 `0.32`） |

### 忽略 / 排除规则（兼容 Augment）

建索引时的过滤顺序类似 Augment Context Connectors：

1. **内置智能过滤** — `node_modules/`、`vendor/`、`dist/`、`build/`、`target/`、二进制、锁文件、`.env` 密钥、IDE 垃圾等
2. **`.gitignore`**（根目录 + 嵌套规则）
3. **`.augmentignore`**（与 Augment 语义一致；支持 `!` 重新包含）
4. **`.contextengineignore`**（本产品专用）
5. **CLI / 环境变量** — `contextengine index --exclude 'vendor/**' '**/*.generated.*'` 或 `CONTEXTENGINE_EXCLUDE=...`

`.augmentignore` 示例：

```bash
# 重新包含被 gitignore 的内容
!some-tracked-deps/

# 排除测试数据 / 本地文件
data/test.json
*.tmp
```

---

## 库 API

```ts
import { ContextEngine } from "contextengine-plugin";

const engine = ContextEngine.open({ root: "/repo" });

await engine.index((p) => console.log(p.phase, p.filesDone));
const stats = await engine.stats();
const hits = await engine.search({ query: "…", topK: 8, mode: "auto" });
const packed = await engine.getTaskContext({
  task: "…",
  // 可选的调用方传输限制：maxTokens: 16_000,
});
await engine.close();
```

---

## 多仓库 Profile

```bash
contextengine profile add app --root ~/work/my-app
contextengine profile add api --root ~/work/my-api
contextengine profile use app
contextengine profile list
```

会写入 `contextengine.profiles.json`（示例见 `examples/contextengine.profiles.example.json`）。

## 评测

```bash
# 对本仓库的内置用例
contextengine eval --self --reindex

# 自定义用例
contextengine eval --cases examples/eval.sample.json --root /path/to/repo

# 中等规模练习（Express 4.x）— IR 指标 + 增量耗时
# git clone --depth 1 --branch 4.21.2 https://github.com/expressjs/express.git /tmp/express4
node scripts/practice-eval.mjs --root /tmp/express4 --cases examples/eval.express.json

# 成对 Agent PR 评测（manifest 命令需要显式授权）
contextengine eval-pr \
  --manifest /path/to/pr-suite.json \
  --allow-exec \
  --out eval-results/pr-suite.json \
  --markdown eval-results/pr-suite.md

# 固定 corpus 的 CI oracle 门禁：每个测试补丁必须可应用，base 必须失败、gold 必须通过。
# 不会调用 Agent；必须在完整源码 Git clone 中运行。
npm run eval:pr:corpus:validate

# 完整固定 corpus 运行：需要 PostgreSQL 和真实的 agent-wrapper。
# package script 有意包含 --allow-exec；运行前先审阅 manifest。
docker compose up -d postgres
export CONTEXTENGINE_DATABASE_URL=postgresql://contextengine:contextengine@127.0.0.1:54329/contextengine
npm run eval:pr:corpus
```

实践报告（方法 + 多仓套件 + watch）：**[EVALUATION.md](./EVALUATION.md)**

PR 级 harness、manifest、隔离与 Agent 指标：**[docs/PR_EVAL.md](./docs/PR_EVAL.md)**

V1 runner 已具备重复成对编排、确定性测试门禁、报告能力和 3 个固定历史任务：
它会记录原始任务、实际 Agent prompt 与 context 的哈希，报告已解析的 base/gold commit，
并比较每一组 `none x packed` 变体。baseline oracle 在独立的 sanitized workspace 中运行，
忽略文件产生的构建产物不会流入 Agent workspace。固定 corpus 必须使用包含历史提交的完整 Git clone，
且完整运行需要 PostgreSQL 和 `agent-wrapper`。但尚未发布公共大样本 corpus、受控真实模型实验或可与
Augment 对比的质量结果。`testPatch` 的不可见性是仓库级防误泄漏措施，不是 OS 安全边界。

代码 embedding 选型：**[docs/EMBEDDINGS.md](./docs/EMBEDDINGS.md)**

GPU embed + rerank 部署：**[docs/DEPLOY_EMBED_RERANK.md](./docs/DEPLOY_EMBED_RERANK.md)**
多语言 IR 指标：**[docs/MULTILANG_BENCH.md](./docs/MULTILANG_BENCH.md)**

```bash
# 多仓中等规模套件（克隆到 /tmp/ce-bench）
node scripts/bench-suite.mjs

# 多语言开源套件（需要 embeddings 端点）
npm run bench:multilang

# 公网 API 冒烟基准：10 种查询语言 × 10 种代码语言，
# 校验 /health、/v1/embeddings 和 /v1/rerank。
npm run bench:api
```

Colab / TryCloudflare 是临时部署：只在本地 `.env` 或 shell 中设置当前的 Base URL
和 API Key。runner 会在克隆仓库前预检远端服务，隧道失效时不会产出误导性的分数。

## 开发

```bash
npm install
npm run build
npm test
npm run eval:self
npm run cli -- index
npm run mcp
```

---

## 路线图

### Phase 1 — ✅ `0.1.0`

- 混合 BM25 + 可选 embeddings
- 增量 PostgreSQL + pgvector 索引
- MCP + CLI + 库
- 任务上下文打包

### Phase 2 — ✅ `0.2.0`

- 搜索时符号 / import 图扩展
- Watch 模式增量索引
- 提交血缘（近期 git 历史进入索引）

### Phase 3 — ✅ `0.3.x`

- 评测脚手架（`contextengine eval --self`）
- 多仓库 profiles（`contextengine profile`）
- `examples/` 下 MCP 配置示例
- CI、索引导出/导入、与 Augment 对比文档
- 版本化团队索引快照与可插拔 filesystem/S3-compatible store

### Phase 4 — ✅ `0.4.0`（Augment 级栈）

- PostgreSQL FTS + 符号 + 路径多信号检索
- 查询分析、特征重排、MMR 打包
- 多根 / 文档根
- MCP 主工具 `codebase-retrieval`（`codebase_retrieval` 为旧别名）
- MRR + nDCG 指标

### Phase 5 — 进行中

- 可选 neural `/v1/rerank` 二阶段
- 生产 hybrid 默认与 GPU 部署文档

---

## 与 Augment Context Engine

我们是 **开放、可移植的组件**，不是完整的商业上下文平台。

| | 本仓库 | Augment |
|--|--------|---------|
| 自研代码检索模型 | ❌ 自带 / BYO embeddings | ✅ |
| 多源（文档 / wiki / 组织） | ❌ | ✅ |
| 巨型 monorepo / 企业规模 | ⚠️ 中等 | ✅ |
| 已发布 Agent PR benchmark | ⚠️ 固定内部 corpus，无真实模型结果 | ✅ |
| 开源 / 可离线 | ✅ | ❌ 产品 |
| MCP + 混合搜索 | ✅ | ✅ |

详情见 **[COMPARISON.md](./COMPARISON.md)** 和 **[深度对齐审计](./docs/AUGMENT_ALIGNMENT.md)**。

## 设计原则

1. **面向 Agent，而非聊天** — 结果始终带路径 + 行号，便于落地修改。
2. **可离线** — 仅 BM25 是合法模式；embeddings 是增强。
3. **数据库原生检索** — pgvector 负责向量持久化与 ANN，Node 只读取少量候选 chunk。
4. **可组合** — 可作 MCP 插件、CLI，或嵌入你自己的 agent 循环。
5. **范围诚实** — 优化所有权与可改性，不宣称与 Augment 完全对等。

---

## 许可证

MIT — 见 [LICENSE](./LICENSE)。

---

## 致谢

受更广泛的 “context engineering” 实践，以及 Augment Context Engine、Sourcegraph、MCP 生态等产品启发。本项目目标是 **小而开放、可移植的积木**，而不是完整 IDE 套件。
