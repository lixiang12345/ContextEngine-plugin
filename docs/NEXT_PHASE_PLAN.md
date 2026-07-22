# 下一阶段计划：跨实例 Remote MCP 会话

更新时间：2026-07-21

起始基线：`3420ddf` (`main`)

当前数据库：PostgreSQL schema v13

当前验证：`npx tsc --noEmit`、`npm run build`、`git diff --check` 与 PostgreSQL
全量测试 `202/202` 通过。

Phase 1 状态（2026-07-22）：已选择并实现路径 A。PostgreSQL 持久化哈希后的
session metadata，后续 JSON POST 在任意实例按请求重建 server/transport；GET/SSE
因包含不可重建的实时流状态而明确返回 405。双实例 100 次 round-robin、实例退出恢复、
全局容量竞态、principal/workspace 隔离、TTL 和幂等 DELETE 自动化测试通过。两个
runtime 容器共享 PostgreSQL 的行为冒烟也已通过；全新 Docker 镜像重建因 Docker Hub
基底镜像 metadata 请求超时未完成，发布前需在网络可用环境复跑镜像构建。

Phase 2 状态（2026-07-22）：已实现可组合 API Key + OIDC JWT 认证、HTTPS
discovery/JWKS、显式算法白名单、issuer/audience/lifetime/key-use 校验、未知 `kid`
限频刷新、稳定 issuer+subject principal 和显式 operator group 映射。现有 API Key
继续可用；OIDC-only 部署自动启用 workspace ACL。全量 PostgreSQL 回归和
OIDC HTTP/MCP token-rotation 集成测试已通过，下一阶段进入 source-level ACL。

Phase 3 状态（2026-07-22）：schema v7 已加入 source/path policy 与最长前缀优先
规则；管理 API、PostgreSQL lexical/semantic/symbol/path/graph 查询、`/file`、
`/context` 和 Remote MCP 已共用同一策略。活跃 MCP session 的下一次工具调用会重新
读取策略。全量回归、schema 迁移与活跃 MCP session 撤权测试已通过，下一阶段进入
connector webhook/SDK 扩展。

Phase 4 状态（2026-07-22）：已实现 provider-neutral signed webhook contract、
GitHub HMAC-SHA256 push adapter、schema v8 persistent inbox、delivery/body replay
保护、数据库时钟 processing recovery、attempt fencing 和有界重试。全量回归已通过，
进入 provider 扩展。

Phase 5 状态（2026-07-22）：已实现内置可插拔静态网站 connector。生产默认只允许
公网 HTTPS，使用 DNS 校验与连接地址固定防止 rebinding，限制同源/路径前缀、robots、
三次重定向、页面数/深度/单页与总字节；HTML 转为稳定可检索文档，ETag、
Last-Modified 与有界 cursor 支持增量 noop。HTTP/PostgreSQL 端到端覆盖首次索引、
304、链接变化、删除与搜索。

Phase 6 状态（2026-07-22）：已实现内置 GitLab connector。它将 branch/tag 解析为
不可变 commit，使用有界分页 tree、变更文件 HEAD metadata 与严格 SHA/size/base64
校验，支持 GitLab Standard Webhooks `whsec_` HMAC、时间戳防重放、legacy token
迁移和持久 inbox；HTTP/PostgreSQL 覆盖首次同步、删除、搜索和签名 webhook refresh。
下一步补 Bitbucket provider 与 GitHub/GitLab CI adapter。

Phase 7 状态（2026-07-22）：已实现内置 Bitbucket Cloud connector。它将 ref 固定为
commit，沿官方分页 `next` 遍历 source 目录，使用同源校验的分页链接、ETag/size
metadata 和 commit-pinned raw reads；`repo:push` 使用 X-Hub-Signature HMAC、原始
body 和 X-Request-UUID，HTTP/PostgreSQL 覆盖首次同步、删除、搜索与 webhook refresh。
下一步实现 GitHub/GitLab/Bitbucket CI adapter。

Phase 8 状态（2026-07-22）：已实现 provider-neutral source-scoped CI trigger。
schema v10 仅存储 `ceci_` token 的 SHA-256，并在 durable webhook inbox 保存严格校验的
CI provenance；支持 1–365 天过期、owner 管理的轮换/撤销、每来源 20 个活动 token 与
10 分钟 60 次速率限制；`POST /ci/sync` 通过持久 inbox 复用 connector
lease/cursor/index-job，delivery/body replay 返回 409，终端结果包含
`ci_provenance`。`contextengine ci-template github|gitlab|bitbucket` 输出可直接安装的
三平台 workflow，且模板使用 provider run id 作为幂等 delivery。下一步进入
S3/team index snapshot。

Phase 9 状态（2026-07-22）：已实现版本化 team index snapshot。导出在活动 physical
generation 上使用 `REPEATABLE READ READ ONLY` 与分页流式 gzip NDJSON；先上传
SHA-256 content-addressed artifact，最后发布 manifest。导入先下载到私有临时文件并校验
压缩/展开上限、size、digest、format/index version、严格 record schema 和计数，再写入
新 generation，全部成功后原子 promotion。`SnapshotObjectStore` 是可插拔契约，内置
atomic filesystem 与 AWS SDK S3-compatible adapter，支持 endpoint/path-style、SSE-S3
与 SSE-KMS；CLI 提供 `snapshot export|import|list|delete|prune|gc`，prune 支持年龄和
保留数量组合策略，GC 只删除没有 manifest 引用的 content-addressed artifact；二者遇到
损坏 manifest 时 fail closed。

Phase 10 状态（2026-07-22）：已完成 owner 管理的 HTTP snapshot API。配置
`CONTEXTENGINE_SNAPSHOT_STORE` 或注入 `SnapshotObjectStore` 后，workspace owner 可通过
`GET/POST /v1/workspaces/{id}/snapshots`、`POST .../{name}/import`、DELETE、prune 和
GC 路由管理快照；每 workspace 使用 hash 前缀隔离共享 bucket，reader 访问隐藏为 404，
import 后自动刷新 engine cache，未配置 store 返回 503。

Phase 11 状态（2026-07-22）：export/import/prune/GC 已改为 PostgreSQL 持久异步任务，
HTTP 创建返回 202，并提供 workspace-scoped 状态轮询与 SSE。schema v11 使用
`FOR UPDATE SKIP LOCKED` claim、过期 lease 接管、attempt token fencing、阶段进度、
终态结果与错误审计；多实例不会重复领取同一 attempt，旧 worker 也不能覆盖新终态。
CLI 仍保留同步语义。已补 `replicateIndexSnapshot` 跨 store 复制原语：临时文件校验、
content-addressed artifact 幂等写入、manifest 最后发布。下一步将其接入可配置的跨区域
复制目标、目标级状态与异步 job。

Phase 12 状态（2026-07-22）：已完成复制控制面的第一版。schema v12 将 `replicate`
纳入同一套 durable job 状态机；HTTP owner 可查看配置目标和最近复制状态，并通过
`POST .../snapshots/{name}/replicate` 异步触发复制。目标由注入的 `SnapshotObjectStore`
或 `CONTEXTENGINE_SNAPSHOT_REPLICATION_TARGETS` 提供，数据库不保存凭据；workspace hash
前缀、attempt fencing、失败重试和 manifest-last 发布继续生效。下一步是每目标调度策略、
带退避的自动重试和复制延迟/容量指标。

Phase 13 状态（2026-07-22）：复制失败已支持有界自动重试和数据库时钟退避，runner
只对具备目标能力的实例 claim；目标状态返回成功/失败/重试计数、平均耗时、最近终态和
复制延迟。下一步是按目标配置定时策略（例如 nightly/interval）和更细的 artifact
吞吐、容量与告警指标。

Phase 14 状态（2026-07-22）：schema v13 已加入 workspace/target/snapshot 唯一的
持久复制策略，支持 `manual`、`interval`、IANA timezone `nightly`、暂停/恢复和 owner
管理 API。多实例使用数据库时钟、`FOR UPDATE SKIP LOCKED` 与活动复制部分唯一索引，
手动和定时触发共享去重语义；v12 升级会先 fence 历史重复活动任务。复制结果与目标
状态新增 artifact 字节、有效吞吐、连续失败以及 bounded health/alert 汇总。下一步是
固定 source manifest digest/generation、目标 manifest 单调发布、跨实例 SSE/event
history、attempt 级审计，以及可选 object-store CAS/head/health 能力。

## 1. 目标

下一阶段优先解决 Remote MCP 会话只能驻留单个 Node.js 进程的问题，使服务可以在
多实例、滚动升级和实例重启场景下继续处理已有 `mcp-session-id`，同时保持当前的
workspace/principal 绑定、Bearer 认证、空闲 TTL、容量限制和删除语义。

完成后应支持：

- 同一 MCP session 的后续请求可以命中任意健康实例，不依赖负载均衡器粘性会话。
- 创建会话的实例退出后，其他实例可以在有界时间内接管。
- session 不能跨 workspace、principal 或认证凭据复用。
- TTL、lease、容量与接管判断统一使用 PostgreSQL `clock_timestamp()`。
- schema 迁移、旧实例并存和失败回滚都有确定性集成测试。

## 2. 先验证的技术约束

当前 `src/http-server.ts` 把 `StreamableHTTPServerTransport`、MCP server 和
`lastSeenAt` 保存在进程内 `Map`。SDK transport 对象不是可直接序列化的 durable
state，因此“把 session id 写入数据库”并不等于跨实例会话。

实现前必须完成一个小型协议 spike，回答：

1. 对当前只读、JSON-response 的工具调用，能否根据持久化的 initialize metadata
   在每个请求上安全重建 server/transport。
2. `POST`、`GET`、`DELETE` 与 MCP notification 是否依赖 transport 内未公开状态。
3. 重建后是否仍满足 SDK 的协议版本、capability negotiation 和 session header 校验。
4. 同一请求重试是否可能造成重复副作用；当前 retrieval 是只读，但生命周期操作仍需
   幂等。

决策门：

- **路径 A，优先：可重建的无状态请求处理。** PostgreSQL 保存 session metadata，
  任意实例按请求重建轻量 server/transport，不保存 SDK 对象。
- **路径 B，兜底：owner lease。** PostgreSQL 保存 owner instance 与 attempt token；
  非 owner 请求必须通过明确的内部转发或可验证的 owner 路由处理。不能只返回一个
  无法被负载均衡器消费的 owner id。

如果路径 A 不满足协议，必须在文档中明确部署需要 sticky routing 或实现内部代理；
不得把仅有数据库记录的方案标记为“durable session 已完成”。

## 3. Phase 1 实施范围

### Step 0：协议 spike 与决策记录

- 为 SDK transport 编写最小双实例实验，不先修改生产表。
- 覆盖 initialize 后由另一实例执行 `tools/list`、`codebase-retrieval` 和 `DELETE`。
- 记录必须持久化的最小字段、不可重建状态和所选路径。
- 输出 `docs/MCP_SESSION_ARCHITECTURE.md`，包含时序图、失败模型和放弃方案。

验收：有自动化测试或可重复脚本证明所选路径，不以人工 curl 结果代替。

### Step 1：schema v5 与 repository 契约

新增 `ce_mcp_sessions`，建议字段：

| 字段 | 用途 |
|---|---|
| `session_id_hash` | session id 的 SHA-256；日志和数据库不保存可直接使用的 header 值 |
| `workspace_id` | FK 到 workspace，删除 workspace 时级联清理 |
| `principal_id` | 强制绑定认证主体 |
| `protocol_version` | initialize 协商结果 |
| `status` | `active`、`closing`、`closed` |
| `owner_instance_id` | 仅路径 B 使用 |
| `owner_attempt_id` | 防止超时 owner 在接管后继续写入 |
| `lease_expires_at` | owner lease，仅路径 B 使用 |
| `last_seen_at` | 数据库时钟维护的空闲 TTL 基准 |
| `created_at` / `updated_at` | 审计与运维 |

repository API 至少包含：

- `createMcpSession(...)`
- `getAuthorizedMcpSession(...)`
- `touchMcpSession(...)`
- `closeMcpSession(...)`
- `acquireMcpSessionLease(...)` / `renewMcpSessionLease(...)`（路径 B）
- `pruneExpiredMcpSessions(...)`
- `countActiveMcpSessions(...)`

约束：所有授权、TTL、状态转换和 attempt fencing 必须在单个 SQL 事务或条件
`UPDATE ... RETURNING` 中完成，不能先读后写依赖 Node.js 时钟。

### Step 2：HTTP 生命周期改造

- 把进程内 session `Map` 抽象成 `McpSessionStore`。
- 保留 `memory` 实现用于单进程兼容，新增 `postgres` 实现。
- PostgreSQL HTTP 部署默认使用 durable store；提供显式配置用于回滚。
- 每次请求都重新校验 Bearer principal、workspace ACL 和 session hash。
- 初始化容量限制升级为跨实例全局限制，避免每实例各自放大上限。
- `DELETE` 必须幂等，并使其他实例立即观察到 closed 状态。
- 错误响应区分 unknown、expired、closed、principal mismatch 和 capacity exhausted，
  但不能泄露其他 principal 的 session 是否存在。

### Step 3：租约、清理与滚动升级

- 路径 B 使用 attempt token 与有界 lease，模式复用 connector sync fencing。
- 实例关闭时尽力释放 owner，但正确性不能依赖 graceful shutdown。
- 后台清理使用数据库时钟，批量删除 expired/closed session，并设置上限。
- schema v5 迁移先安装必要 guard/lock，再执行可能阻塞的 DDL。
- v4 旧进程完全不知道 durable session 表，数据库 trigger 无法让它遵守 v5 的全局
  容量和 ownership。发布流程必须 drain v4 Remote MCP 流量，或通过版本路由保留旧
  session；在 v4 实例退出前不得宣称无粘性跨实例语义已经生效。
- 旧二进制重启应继续拒绝较新 schema；升级文档必须给出 drain、切流和回滚步骤。

### Step 4：可观测性与配置

增加无敏感标识的指标：

- active/expired/closed session 数量
- initialize、resume、takeover、close 计数
- lease conflict、principal mismatch、capacity rejection 计数
- session lookup 与 takeover 延迟

dashboard 只展示聚合统计，不显示 session id、Bearer token 或 principal 的原始值。

建议配置：

- `CONTEXTENGINE_MCP_SESSION_STORE=postgres|memory`
- `CONTEXTENGINE_INSTANCE_ID`（路径 B；未设置时生成进程级随机值）
- 沿用 `CONTEXTENGINE_MCP_SESSION_IDLE_TTL_MS`
- 沿用 `CONTEXTENGINE_MCP_MAX_SESSIONS`，语义改为全局上限

### Step 5：测试矩阵

必须使用两个独立 HTTP server/repository 实例连接同一测试 schema：

1. 实例 A initialize，实例 B 执行 tools/list 与 retrieval。
2. A 退出后 B 恢复或接管同一 session。
3. 路径 B 下，两实例并发接管时只有一个 attempt 成功。
4. 路径 B 下，旧 owner 在接管后无法 touch、close 或返回有效结果。
5. Alice session 被 Bob、其他 workspace 或错误 token 使用时拒绝。
6. TTL 在长事务中途到期时最终写入回滚。
7. 全局容量在并发 initialize 下不超限。
8. DELETE 重试幂等，关闭后所有实例立即拒绝调用。
9. v4→v5 迁移在锁竞争、滚动升级和重复启动下安全。
10. 服务重启后 session 行为符合所选路径的承诺。

完成后运行：

```bash
npx tsc --noEmit
CONTEXTENGINE_DATABASE_URL=... CONTEXTENGINE_TEST_DATABASE_URL=... npm test
npm run build
git diff --check
```

并用 Docker Compose 启动至少两个 HTTP 实例做 round-robin 冒烟测试。

## 4. Phase 1 验收标准

- 不使用 sticky session 时，双实例连续 100 次 MCP 请求无 session 丢失。
- 路径 A 下实例退出不影响下一请求；路径 B 下 kill -9 owner 后在一个 lease 窗口内
  恢复，且没有两个 owner 同时成功。
- 所有 principal/workspace 越权测试通过，错误不泄露 session 存在性。
- 数据库和日志中没有原始 Bearer token 或可直接重放的 session id。
- 完整测试、构建、Docker 双实例探针通过。
- README、HTTP API、Compose 示例、CHANGELOG 和 alignment 文档同步更新。
- 不宣称跨实例 durable，直到真实双实例与重启测试通过。

## 5. 后续阶段顺序

Phase 1 完成后按以下顺序继续，避免在身份与隔离基础不稳时扩展数据面：

1. **OAuth/OIDC（已完成）**：issuer/audience/JWKS 校验、key
   rotation、subject/group 映射，兼容现有 API key；禁止从未验证的 token claim
   直接授予 operator。
2. **source-level ACL（路径策略已实现）**：repo/path/document 权限已在 retrieval、
   file read、MCP 三层强制执行；后续 connector 阶段继续补 provider permission
   snapshot 与 provenance。
3. **connector SDK + webhook（签名 webhook/inbox、GitHub/GitLab/Bitbucket/website、
   source-scoped CI trigger、可安装 CI workflow 与 provenance 已实现）**：事件
   idempotency 已由 schema v8+ inbox 与现有 cursor/lease 共同保证。
4. **PR 评测扩容**：公共多仓库 corpus、受控真实模型重复实验、token/tool-call/P95 与
   测试结果的可复现报告。
5. **检索质量**：SCIP/语言服务符号提供器、multi-hop query rewrite、可插拔
   extractive/model-summary packing。

## 6. 新对话启动指令

新对话直接使用：

```text
读取 docs/NEXT_PHASE_PLAN.md 和当前代码，从 Phase 1 Step 0 开始执行。
先验证 StreamableHTTPServerTransport 是否能跨实例重建，不要先假设数据库记录等于
durable session。完成架构决策、实现、双实例竞态测试、全量验证和 Docker 冒烟；
保留现有未提交改动，除非我明确要求，不要创建 Git commit。
```
