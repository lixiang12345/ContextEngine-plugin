# ContextEngine Plugin

**面向 AI 编程 Agent 的可移植、Augment 级代码库上下文引擎。**

多信号检索（FTS5 + 符号 + 路径 + 可选向量 + 图扩展 + MMR），让 Agent 少花 token 乱 grep，多花回合改对代码。

设计说明：[ARCHITECTURE.md](./ARCHITECTURE.md) · 与 Augment 的诚实对比：[COMPARISON.md](./COMPARISON.md)

**English:** [README.md](./README.md)

**第一次用？** 按你的环境选路径：

| 路径 | 文档 |
|------|------|
| 仅 BM25 / 云端 Embed / 自建 GPU | **[docs/GETTING_STARTED.md](./docs/GETTING_STARTED.md)** |
| GPU 运维（Qwen3 embed + rerank） | [docs/DEPLOY_EMBED_RERANK.md](./docs/DEPLOY_EMBED_RERANK.md) |
| 多语言 IR 指标 | [docs/MULTILANG_BENCH.md](./docs/MULTILANG_BENCH.md) |

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
| 词法检索 | SQLite **FTS5 BM25**（可扩展） |
| 符号检索 | 精确 / 前缀符号表 |
| 语义检索 | 可选 Embeddings，候选上的 **两阶段** 打分 |
| 融合 + 重排 | RRF + 代码感知特征打分 |
| 多样性打包 | 按路径 MMR，受 token 预算约束 |
| 符号 / import 图 | 扩展相关文件 |
| 多根目录 | 代码 + 文档 / 额外仓库同一索引 |
| 提交血缘 | 近期 git 历史块 |
| Watch 模式 | 防抖增量重建索引 |
| MCP | 主工具 `codebase_retrieval` + 搜索 / 文件 / 索引 |
| 评测 | Recall@k、**MRR**、**nDCG@k** |

**与 Augment 的对比：** [COMPARISON.md](./COMPARISON.md) · **架构：** [ARCHITECTURE.md](./ARCHITECTURE.md)

---

## 安装

### 环境要求

- **Node.js ≥ 22.5**（使用内置 `node:sqlite`）

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
contextengine index
# 或
contextengine index /path/to/repo
```

索引数据位置：

```text
<repo>/.contextengine/index.db
```

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
| `codebase_search` | 混合搜索 → 路径、行号、符号、内容 |
| `get_task_context` | 在 token 预算下打包排序后的代码块 |
| `get_file_context` | 读取文件 / 行范围 |
| `index_status` | 索引统计 |
| `reindex_workspace` | 增量重建索引 |

**Agent 建议：** 先调 `get_task_context` 再改代码；后续追问用 `codebase_search`。

---

## CLI 参考

```text
contextengine index [root] [--data-dir dir] [--quiet]
contextengine search <query> [-k N] [--mode auto|bm25|semantic|hybrid] [--path-prefix p] [--json]
contextengine context <task> [--max-tokens N] [--json]
contextengine status
contextengine watch [root] [--debounce 800]   # 实时重建索引
contextengine serve [--auto-index]            # MCP stdio
contextengine eval [--self | --cases file.json] [--reindex]
contextengine profile list|add|use …
contextengine export-index ./share.db
contextengine import-index ./share.db
```

---

## 配置

| 环境变量 | 含义 |
|----------|------|
| `CONTEXTENGINE_ROOT` | MCP 使用的工作区根目录 |
| `CONTEXTENGINE_DATA_DIR` | 覆盖索引目录 |
| `CONTEXTENGINE_AUTO_INDEX` | `1` = MCP 首次使用时若无索引则自动建 |
| `CONTEXTENGINE_COMMIT_LIMIT` | 索引的近期 commit 数量（默认 `80`，`0` = 关闭） |
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
const stats = engine.stats();
const hits = await engine.search({ query: "…", topK: 8, mode: "auto" });
const packed = await engine.getTaskContext({
  task: "…",
  maxTokens: 6000,
});
engine.close();
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
```

实践报告（方法 + 多仓套件 + watch）：**[EVALUATION.md](./EVALUATION.md)**  
代码 embedding 选型：**[docs/EMBEDDINGS.md](./docs/EMBEDDINGS.md)**  
GPU embed + rerank 部署：**[docs/DEPLOY_EMBED_RERANK.md](./docs/DEPLOY_EMBED_RERANK.md)**  
多语言 IR 指标：**[docs/MULTILANG_BENCH.md](./docs/MULTILANG_BENCH.md)**

```bash
# 多仓中等规模套件（克隆到 /tmp/ce-bench）
node scripts/bench-suite.mjs

# 多语言开源套件（需要 embeddings 端点）
npm run bench:multilang
```

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
- 增量 SQLite 索引
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

### Phase 4 — ✅ `0.4.0`（Augment 级栈）

- FTS5 + 符号 + 路径多信号检索
- 查询分析、特征重排、MMR 打包
- 多根 / 文档根
- MCP 主工具 `codebase_retrieval`
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
| 开源 / 可离线 | ✅ | ❌ 产品 |
| MCP + 混合搜索 | ✅ | ✅ |

详情见 **[COMPARISON.md](./COMPARISON.md)**。

## 设计原则

1. **面向 Agent，而非聊天** — 结果始终带路径 + 行号，便于落地修改。
2. **可离线** — 仅 BM25 是合法模式；embeddings 是增强。
3. **零 native 插件** — 仅 Node 22 `node:sqlite`，安装简单。
4. **可组合** — 可作 MCP 插件、CLI，或嵌入你自己的 agent 循环。
5. **范围诚实** — 优化所有权与可改性，不宣称与 Augment 完全对等。

---

## 许可证

MIT — 见 [LICENSE](./LICENSE)。

---

## 致谢

受更广泛的 “context engineering” 实践，以及 Augment Context Engine、Sourcegraph、MCP 生态等产品启发。本项目目标是 **小而开放、可移植的积木**，而不是完整 IDE 套件。
