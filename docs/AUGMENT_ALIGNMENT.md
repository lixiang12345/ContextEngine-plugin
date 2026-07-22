# ContextEngine 与 Augment Context Engine 对齐报告

更新时间：2026-07-22。本文把公开的 Augment 产品/文档能力与当前仓库代码逐项核对，区分“官方文档明确说明的能力”和“厂商营销或尚未独立复现的指标”。目标不是声称功能等价，而是确定 ContextEngine 下一阶段最值得投入的工程工作。

## 结论摘要

ContextEngine 已经覆盖了核心闭环：索引、混合检索、上下文打包、MCP、HTTP 同步和本地可观测性。当前版本的主要差距不在再增加一个搜索入口，而在以下四个产品层能力：

1. 外部数据连接器与持续同步（GitHub、网站、工单、内部文档等）。
2. 企业级授权、租户隔离和“用户确实拥有该来源”的证明链。
3. 面向大规模多仓库的索引分发、保留和并发作业控制。
4. 已有 PR 级重复成对编排和 3 个固定历史任务，但仍缺公共大样本 corpus、受控真实模型实验和可与 Augment 对比的结果；任务级上下文压缩也仍需加强。

ContextEngine 的明确优势仍然成立：MIT、可自托管、可离线运行、源码可改、BM25 不依赖外部模型，且 PostgreSQL 中的 workspace/generation 边界可由部署方掌控。

## 官方能力基线

下表中的链接均来自 Augment 官方网站或官方文档索引（`https://docs.augmentcode.com/llms.txt`）。

| 能力 | 官方资料中可核验的描述 | 当前 ContextEngine | 差距 |
|---|---|---|---|
| Context Engine MCP | 提供 `codebase-retrieval`，可接入多种 agent；本地模式随工作区实时更新，远程模式连接选定仓库 | stdio MCP 已提供 `codebase-retrieval`，并保留旧下划线别名；默认 watcher 会监听主根和额外根 | 低到中 |
| Remote MCP | Context Connectors 文档给出 Streamable HTTP、Bearer key、session id、可选 search-only/CORS；托管 MCP 另支持 OAuth/API key | HTTP 服务已有 workspace-scoped JSON-response MCP、API Key + OIDC、精确 Origin CORS、PostgreSQL durable session、数据库时钟 TTL 与跨实例全局容量 | 低到中：GET/SSE 未实现 durable event stream，尚缺 provider-specific OAuth client UX |
| 混合/语义检索 | 官方强调语义理解、代码关系和任务相关上下文；具体模型实现未公开 | PostgreSQL FTS、symbol/path、pgvector、RRF、MMR、可选 neural rerank；模型 BYO | 高：检索模型质量与大规模验证不足 |
| 多仓库/工作区上下文 | IDE 可添加额外仓库和文件夹，并显示同步状态 | `CONTEXTENGINE_EXTRA_ROOTS`、profiles、HTTP workspace 与 revision/generation 状态 | 中：没有 IDE 活跃文件/编辑状态上下文 |
| 历史和关系 | 官方宣传 commit history、codebase patterns、服务依赖和跨 repo 关系 | git commit chunks、symbol/import graph expansion | 中到高：缺跨仓库关系图和更深的 lineage |
| Connectors | 官方提供 GitHub/GitLab/Bitbucket、网站、webhook、GitHub Actions、S3，以及 custom indexer/client/store | provider-neutral `SourceConnectorPlugin`、内置四类来源、schema v12 CI trigger/provenance、可插拔 team snapshot store、复制目标和异步 HTTP 管理 API | 低：缺托管安装 API 与复制调度指标 |
| SDK / 自定义来源 | `DirectContext` 可把 API、数据库、memory、磁盘内容加入索引并保存状态 | TypeScript `ContextEngine` API；输入主要是本地树或 HTTP Blob | 中到高 |
| 规则和团队知识 | CLI 支持 `AGENTS.md`、`CLAUDE.md`、`.augment/rules`、用户规则和 agent-requested 规则 | 仓库可读取代码/文档，但没有规则解析、优先级和持久化 memory 层 | 高 |
| 权限 | Auggie/Cosmos 支持 allow/deny、脚本或 webhook policy、工具级匹配和审计语义 | API Key/OIDC principal、workspace ACL、schema v7 source/path ACL、local-root allowlist、模型 URL SSRF 防护、路径边界校验 | 中到高：缺 connector 权限快照、外部策略 webhook 和完整审计流 |
| 自动更新 | Remote default branch 随 push 更新；Connectors 提供 webhook/GitHub Actions | 本地 watcher、签名 GitHub/GitLab/Bitbucket push webhook、可安装 source-scoped CI workflow、CI provenance 与 HTTP sync/index jobs | 低：缺托管安装 API |
| 团队索引共享 | 官方文档给出 S3 store/team sharing | 可共享 PostgreSQL workspace；版本化 snapshot 支持 content-addressed gzip、checksum、atomic generation import、filesystem/S3-compatible store、list/delete、retention prune/GC、复制目标、目标级状态，以及带 claim/lease/fencing 的 owner 异步 HTTP jobs | 低：缺复制调度策略与延迟指标 |
| 评测 | Augment 公开过端到端 PR 评测和 token/tool-call 叙述 | 有 Recall/MRR/nDCG、多仓库脚本、重复成对 `eval-pr` 和 3 个固定历史任务 | 高：缺公共大样本 corpus、受控真实模型结果和可比结论 |

## 当前实现核对

以下判断来自仓库当前代码与测试，而不是 README 的预期描述：

- `src/mcp-server.ts` 默认启动 watcher；`CONTEXTENGINE_MCP_WATCH=0` 可关闭，首次索引与首个工具请求共享 single-flight。
- `src/mcp-tools.ts` 把 `codebase-retrieval` 注册成稳定的 agent-facing 契约，stdio 和 HTTP 复用同一套参数与上下文打包逻辑。
- `src/http-server.ts` 提供 `/v1/workspaces/{id}/mcp` 的 JSON-response Streamable HTTP 入口；schema v5 MCP 表只持久化 session 哈希与授权 metadata，支持无粘性跨实例 POST、重启恢复、数据库时钟 TTL、全局容量和幂等 DELETE。当前总 schema 为 v12，已包含通用 connector provider、source/path ACL、webhook inbox、source-scoped CI token/provenance、snapshot jobs 和 replication targets。GET/SSE 因无法从 metadata 重建实时流而明确返回 405。
- `src/connectors/website.ts` 提供内置静态网站来源：生产默认仅允许公网 HTTPS，DNS 校验后固定连接地址，限制同源/路径/robots/重定向/页面/深度/字节，并用 ETag/Last-Modified 与有界 cursor 增量同步 HTML 文本。
- `src/store/postgres-store.ts` 使用 copy-on-write generation、原子 promotion、revision guard 和过期 generation GC；搜索响应带 `generation_id`、source/indexed/pending revision。
- `src/search/postgres-hybrid.ts` 为 semantic 和 rerank 设置超时、AbortSignal、独立 circuit breaker；模型失败时返回 lexical 结果并标注 `degraded_channels`。
- `src/engine.ts` 的 context packer 按文件做多样化排序，去掉重复段落，并对 `maxTokens` 做硬字符上限；这是可靠的传输预算，但还不是语义摘要压缩。
- `src/dashboard.ts` 已有 dark mode、主题持久化、loading/toast、快捷检索、移动端布局、generation/revision 和 indexing 状态。
- `src/eval/pr-harness.ts` 已提供 V1 PR 编排：固定 base/gold commit、`sanitized`/`shared-history` Git 隔离、按 repetition 的 baseline/context 成对运行、测试门禁、patch 统计和可选 agent metrics；`benchmarks/pr-history` 提供 3 个已验证 fail-to-pass 的固定历史任务。它们仍不是已完成的真实模型 benchmark。

## 本机可复现实测

截至 2026-07-22，本仓库 `npm run build` 通过，带 PostgreSQL 的完整测试为
**199/199**；`contextengine eval --self` 在当前索引上为 8/8，Recall/MRR/nDCG
和 Top-1/3/5 均为 1.0，平均延迟 2.14 秒、P95 4.17 秒。Docker Compose 的
HTTP 与 PostgreSQL 容器均为 healthy，Remote MCP 已实测 initialize、tools/list、
`codebase-retrieval`、DELETE 会话链路。当前配置的 embedding/reranker 探测均返回
HTTP 200；延迟主要来自远程模型服务。这些结果是本机当前配置的工程基线，不是
与 Augment 使用相同语料、模型和 agent 预算的横向 benchmark。

PR harness 的自动化覆盖使用确定性的 fake agent 验证编排、argv、隔离、重复配对和报告；
仓库尚未发布固定 corpus 上的受控真实模型运行结果。`testPatch` 不会出现在
agent 工作仓库中，但这不是 OS 级保密：与 runner 同权限且可读取宿主文件系统的
进程仍可能访问原始 patch 路径。

## 官方宣传与事实的边界

Augment 产品页中的“数十万文件”“更少 token 仍达到相近 solve rate”等属于厂商自发布定位或 benchmark 宣称。公开资料没有提供足以在本仓库完全复现的模型权重、数据集、完整提示词、评审标注和运行成本，因此本项目不能把这些数字当作已证实的横向对比。

更稳妥的比较方式是同时记录：固定 commit、查询集、gold paths、Recall/MRR/nDCG、Top-1/Top-3、P95 latency、索引耗时、输出 token、agent tool calls 和最终测试通过率。任何“优于 Augment”的结论都必须基于同一 corpus、同一模型、同一预算和公开原始结果。

## 分阶段路线

### P0：质量基线（现在就做）

- 固定版本的多语言、多仓库 golden query suite；每次 CI 输出 Recall@k、MRR、nDCG、Top-1/3/5、P50/P95。
- 将 3 个内部历史任务扩展为公开、多仓库、固定 commit 的 PR task corpus，并在相同 agent、模型、提示词、预算和重复次数下运行 baseline/context 成对实验。
- 为每个响应记录 generation、revision、检索 channel、degraded channel、packed token estimate，形成可比较的 retrieval trace。
- 把字符预算升级成可插拔的 packing policy：`raw`、`extractive`、`model-summary`；默认仍使用无外部模型的 hard cap。
- 增加失败注入测试：模型超时、索引 promotion 中断、旧 generation reader、重复 webhook、Blob 重放。

### P1：连接与远程部署

- provider-neutral connector interface、GitHub/GitLab/Bitbucket 与静态网站已完成；schema v12 source-scoped CI trigger、严格 CI provenance 与三平台可安装 workflow 已完成；team snapshot 已提供 filesystem/S3-compatible store、完整性校验、generation 原子导入、retention prune/GC、复制目标、目标级状态与 owner 异步 HTTP jobs，下一步补复制调度与指标。
- 签名校验、幂等 event id 和持久化队列已完成；继续把 GitHub Actions 作为无常驻服务的备选，并增加其他 provider adapter。
- Remote MCP 的 CORS allowlist 和 OAuth/OIDC 已完成；如果未来需要 GET/SSE 或 server-initiated notification，再增加外部 event store 或带内部转发的 owner lease。
- generation GC 增加空间指标、失败重试和跨进程 job lease；对超大 monorepo 做分片/分区压力测试。

### P2：企业上下文

- source-level ACL（repo/path/document）已在检索、file read、MCP 三层强制执行；继续增加 provider permission snapshot 和审计事件。
- 为来源保存 connector identity、commit/cursor、权限快照和可验证 provenance；拒绝只在 UI 层过滤。
- 增加 `.augment/rules` 类规则加载器与 `AGENTS.md` 层级合并，明确 always/agent-requested 优先级。
- 提供对象存储 index snapshot/import，支持团队共享但不泄露原始代码。

## 官方参考链接

- [Context Engine MCP overview](https://docs.augmentcode.com/context-services/mcp/overview.md)
- [Remote MCP Server](https://docs.augmentcode.com/context-services/context-connectors/quickstart/remote-mcp-server.md)
- [Context Connectors overview](https://docs.augmentcode.com/context-services/context-connectors/overview.md)
- [GitHub Actions auto-indexing](https://docs.augmentcode.com/context-services/context-connectors/quickstart/github-actions-indexing.md)
- [Auto-index with webhooks](https://docs.augmentcode.com/context-services/context-connectors/quickstart/auto-index-webhook.md)
- [Store indexes in S3](https://docs.augmentcode.com/context-services/context-connectors/quickstart/share-with-s3.md)
- [Context Engine SDK](https://docs.augmentcode.com/context-services/sdk/overview.md)
- [Workspace context](https://docs.augmentcode.com/cli/setup-auggie/workspace-context.md)
- [Rules and guidelines](https://docs.augmentcode.com/cli/rules.md)
- [Tool permissions](https://docs.augmentcode.com/cli/permissions.md)
- [Augment Context Engine product page](https://www.augmentcode.com/context-engine)
- [Augment MCP announcement](https://www.augmentcode.com/blog/context-engine-mcp-now-live)
