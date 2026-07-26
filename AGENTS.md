# Repository Guidelines

## Project Structure & Module Organization

Production TypeScript lives in `src/`. Major subsystems are grouped by purpose: `search/` handles retrieval and reranking, `indexer/` crawls and watches workspaces, `store/` contains PostgreSQL and migration code, and `connectors/` integrates external sources. Entry points include `cli.ts`, `mcp-server.ts`, and `http-server.ts`; `engine.ts` exposes the library API. Tests are in `test/` and mirror behavior rather than directory structure. Documentation belongs in `docs/`, runnable support utilities in `scripts/`, sample configurations in `examples/`, and evaluation fixtures in `benchmarks/`. Treat `dist/` and `eval-results/` as generated output.

## Build, Test, and Development Commands

- `npm install`: install dependencies; Node.js 22.5 or newer is required.
- `npm run build`: clean `dist/`, compile TypeScript, and validate executable entry points.
- `npm run dev`: run the TypeScript compiler in watch mode.
- `npm test`: execute all `test/**/*.test.ts` files with Node's test runner and `tsx`.
- `npm run cli -- index`: run the CLI directly from source.
- `npm run db:up` / `npm run db:down`: start or stop the local PostgreSQL/pgvector service.
- `npm run eval:self`: build, reindex, and run the retrieval self-evaluation; use after search or ranking changes.

## Coding Style & Naming Conventions

Use ESM TypeScript with explicit `.js` extensions in relative imports. Follow the existing two-space indentation, double quotes, semicolons, and trailing commas in multiline constructs. Use `camelCase` for functions and variables, `PascalCase` for types and classes, and kebab-case filenames such as `query-analyzer.ts`. Keep modules focused and dependency-light. The strict `tsconfig.json` rejects unused symbols and fallthrough; `npm run build` is the formatting-adjacent quality gate because no separate linter is configured.

## Testing Guidelines

Write tests with `node:test` and `node:assert/strict`. Name files `<feature>.test.ts` and add regression coverage for every behavior change. Database tests require `CONTEXTENGINE_TEST_DATABASE_URL`; the Compose service supplies a compatible local pgvector instance. Before submitting, run `npm test && npm run build`. Also run corpus validation or self-evaluation when modifying retrieval logic.

## Commit & Pull Request Guidelines

Recent history follows Conventional Commits, for example `feat: atomically grant source-scoped access` and `fix: renew connector webhook processing leases`. Keep subjects imperative, scoped, and concise. Pull requests should explain the problem and solution, link relevant issues, list verification commands, and note configuration or compatibility effects. Include screenshots for dashboard changes and evaluation results for retrieval-quality changes. Never commit secrets; derive local settings from `.env.example`.

## Agent Collaboration & Progress Tracking

Use the [ContextEngine Notion project](https://app.notion.com/p/3a654b8fc7d681479b12c3f2031fd3b4) to track implementation. Update the related task when work starts, after material milestones, when blocked, after verification, and at handoff; attach test results, decisions, screenshots, and remaining risks.

For substantial changes to `src/dashboard.ts`, invoke the local Claude Code CLI in two separate passes: a scoped implementation pass, then a read-only or plan-mode audit of visual hierarchy, typography, spacing, responsiveness, accessibility, interactions, and all loading/empty/error/disabled/hover/focus/selected states. Do not use permission-bypass flags. Review Claude's diff, preserve unrelated user changes, run `npm test && npm run build`, and visually verify light/dark themes at mobile, tablet, and desktop widths.

Drive Claude through a PTY-backed interactive session in this repository. Use `--permission-mode acceptEdits` or explicit approvals for implementation and `--permission-mode plan` for audits. Keep follow-ups in the same terminal session, exit with `/exit`, and resume by the session ID Claude prints. The configured gateway is verified with the interactive TUI; do not default to `claude -p` when that headless path stalls.
