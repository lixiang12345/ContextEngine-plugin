# PR-level agent evaluation

`contextengine eval-pr` measures whether repository context helps an external
coding agent produce a test-passing patch. It complements the retrieval-only
`contextengine eval` metrics; it does not replace Recall/MRR/nDCG regression
tests.

The repository includes the V1 orchestration harness, deterministic fake-agent
tests, and a three-case fixed corpus derived from this repository's history. It
does not yet include a broad public PR corpus, controlled real-model results, or
results that are directly comparable with Augment's published benchmark.

## What the harness measures

Each case is run `repetitions` times per configured variant from the same fixed
Git commit. `repetitions` defaults to `1` and is capped at `20`. The default
pair is:

- `baseline`: task prompt only
- `contextengine`: task prompt plus a packed ContextEngine evidence block

The report records solve rate, test status, changed files, patch size, duration,
ContextEngine hit paths/token estimate, and optional agent-reported token, tool,
model, and cost data. Every run has a stable `runId` and one-based
`repetition`. It also records the SHA-256 of the raw task prompt from the
manifest (`promptSha256`), the exact prompt file sent to the agent
(`agentPromptSha256`), and the exact context file (`contextSha256`; the empty
file is hashed for `none`). The paired summary compares every prompt-only
(`none`) variant with every packed-context (`packed`) variant for matching
`caseId@repetition` runs, then reports both pair-level and case-level improved,
regressed, unchanged, and excluded outcomes instead of collapsing results into
an opaque score.

## Safety and repository isolation

Manifest commands execute local programs. The CLI therefore requires an
explicit `--allow-exec` after the manifest has been reviewed. Commands are argv
arrays executed with `shell: false`; task text and placeholders are never parsed
by a shell.

The default `sanitized` isolation mode creates a fresh shallow Git repository
containing only the fixed base commit and removes the temporary fetch metadata.
This reduces accidental history leakage through the evaluated repository; it
does not prevent a process with access to the source path (or the host
filesystem) from reading a future fix. The faster `shared-history` mode uses
`git worktree` and is suitable only for trusted smoke tests where history
leakage is irrelevant. Every report records the mode.

When `verifyBaseline` is enabled, the oracle runs in a second fresh sanitized
workspace before the agent starts. It has its own setup directory and is never
the agent workspace, so setup-generated ignored artifacts (for example,
`node_modules`) cannot leak between baseline verification and the agent run.
Every report records the resolved base commit and, when configured, the
resolved gold commit. Markdown shortens those commit IDs to 12 characters for
readability; JSON retains the full values.

Without `agent.sandbox`, this is Git-history and workspace isolation only. The
agent command runs with the permissions and inherited environment of the
invoking user and may read files outside the temporary repository. JSON and
Markdown reports identify this execution boundary as `host`.

An optional `testPatch` is applied only for baseline verification and after the
agent patch has been captured. It is not present while the agent is running and
is excluded from changed-file and patch statistics. This prevents accidental
test leakage through the evaluated repository. In host mode it does not make
the patch an OS-level secret: a process with the invoking user's permissions
can still read the original patch path.

### Docker agent sandbox

Set `agent.sandbox.type` to `docker` when the hidden oracle must be outside the
agent's OS-level filesystem boundary. Docker mode requires `isolation` to remain
`sanitized` and an image pinned by immutable `@sha256` digest. The image must be
pre-pulled: the runner uses `--pull never` so an evaluation cannot silently
change its agent image or contact a registry.

Only the fresh agent workspace (`/workspace`, read/write) and the run artifact
directory (`/run`, read/write) are mounted. The source repository, original
`testPatch`, env file, Docker socket, and other host paths are not mounted. The
container runs with a read-only root filesystem, all Linux capabilities
dropped, `no-new-privileges`, a tmpfs `/tmp`, the invoking POSIX UID/GID, and
bounded CPU, memory, and PID resources. Network access defaults to `none`;
choose `bridge` explicitly only when the agent must reach a model API.

The exact agent executable is forced with Docker `--entrypoint`; image defaults
cannot replace or wrap the reviewed argv. Placeholders and
`CONTEXTENGINE_PR_EVAL_*` values use the container paths. Literal `agent.env`
values and host variables named by `agent.envPass` are written to a mode-0600
temporary env file outside both mounts, then deleted before hidden tests run.
Missing `envPass` variables fail before the agent starts. Reports record the
image digest, network, resource limits, and hardening controls, but never env
values.

An attached `docker run` returns only after the container stops. On timeout or
abnormal signal, the runner additionally force-removes the named container
before applying hidden tests. If it cannot prove the container stopped, the run
fails closed as an infrastructure/cleanup error and the oracle is not executed.
Docker CLI exit codes 125–127 are likewise infrastructure errors, not model
failures.

This boundary assumes a trusted Docker daemon, kernel, and pinned image. It is
not equivalent to a hardened VM against kernel/container-runtime exploits.
Setup and final test commands still run on the host; only the agent command is
containerized, so manifests and oracle commands still require review.

On POSIX, each command runs in a detached process group and timeout cleanup
terminates the whole group. Windows uses the direct-child fallback, so a
misbehaving descendant process can remain after timeout; use conservative
timeouts and a container/job boundary when that residual-process risk matters.

## Run a suite

```bash
npm run eval:pr -- \
  --manifest examples/pr-eval.sample.json \
  --allow-exec \
  --out eval-results/pr-sample.json \
  --markdown eval-results/pr-sample.md
```

Useful filters:

```bash
contextengine eval-pr \
  --manifest /path/to/suite.json \
  --allow-exec \
  --case task-a task-b \
  --variant baseline contextengine \
  --fail-on-unsolved
```

`--keep-worktrees` preserves temporary isolated Git repositories for debugging.
Without it, all temporary repositories are removed after each run. The flag
keeps its historical name even though the default `sanitized` mode is not a
shared Git worktree.

The fixed historical corpus has a separate oracle-only CI gate:

```bash
npm run eval:pr:corpus:validate
```

It checks that every hidden test patch applies, fails on its pinned base commit,
and passes on its pinned gold commit. It does not run an agent or claim a
quality lift.

## Manifest V1

```json
{
  "schemaVersion": 1,
  "name": "my-pr-suite",
  "repository": "/absolute/path/to/repository",
  "baseRef": "main",
  "isolation": "sanitized",
  "agent": {
    "command": ["agent-wrapper", "--workspace", "{workspace}", "--prompt-file", "{prompt_file}"],
    "envPass": ["MODEL_API_KEY"],
    "sandbox": {
      "type": "docker",
      "image": "ghcr.io/example/pr-agent@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "network": "bridge",
      "cpus": 2,
      "memoryMb": 2048,
      "pidsLimit": 256,
      "tmpfsMb": 256
    },
    "timeoutMs": 900000
  },
  "setupCommand": ["npm", "ci"],
  "testCommand": ["npm", "test"],
  "verifyBaseline": true,
  "requireChanges": true,
  "repetitions": 3,
  "variants": [
    { "id": "baseline", "context": "none" },
    {
      "id": "contextengine",
      "context": { "mode": "packed", "topK": 20, "maxTokens": 12000 }
    }
  ],
  "cases": [
    {
      "id": "fix-payment-retry",
      "baseRef": "0123456789abcdef0123456789abcdef01234567",
      "goldRef": "89abcdef0123456789abcdef0123456789abcdef",
      "prompt": "Fix duplicate payment retries without changing successful requests.",
      "testPatch": "fixtures/fix-payment-retry.tests.patch",
      "expectedChangedPaths": ["src/payments/retry.ts"]
    }
  ]
}
```

Relative `repository` and `testPatch` paths are resolved from the manifest's
directory. A case can record an optional `goldRef` for auditability and override
`baseRef`, setup/test commands, timeouts, `verifyBaseline`, and
`requireChanges`.

Available argv placeholders:

| Placeholder | Value |
|---|---|
| `{workspace}` | Isolated repository root |
| `{run_directory}` | Temporary non-repository artifact directory |
| `{prompt_file}` | Task prompt, with packed context for context variants |
| `{context_file}` | Packed context only; empty for baseline |
| `{metrics_file}` | Path for optional structured agent metrics |
| `{case_id}` | Current case id |
| `{variant_id}` | Current variant id |
| `{repetition}` | One-based repetition number |
| `{run_id}` | Stable `case@repetition:variant` identity |

The same values are exposed through `CONTEXTENGINE_PR_EVAL_*` environment
variables, including `CONTEXTENGINE_PR_EVAL_WORKSPACE`, `_PROMPT_FILE`,
`_CONTEXT_FILE`, `_METRICS_FILE`, `_CASE_ID`, `_VARIANT_ID`, `_REPETITION`,
`_RUN_ID`, and `_CONTEXT_MODE`. Prompt, context, and metrics artifact filenames
also include the repetition number.

`examples/pr-eval.docker.sample.json` is a complete Docker-mode skeleton.
Replace its illustrative digest with a real, locally present agent image digest
and set only the allowlisted host variables needed by that adapter. Prefer
`network: "none"` for local/offline models; changing it to `bridge` is an
explicit exfiltration-surface decision.

## Fixed historical corpus

`benchmarks/pr-history/contextengine-v1.json` fixes three repository-local
tasks to full base and gold commit SHAs and supplies hidden fail-to-pass test
patches. The corpus defaults to three repetitions, producing 18 total
executions across the two variants. Each oracle patch adds one uniquely named
new test file under `test/`; it does not modify an existing source or test file.
See `benchmarks/pr-history/README.md` for the exact oracle paths and validation
record.

The corpus repository must be a full source Git clone because its base and gold
commits are historical (a shallow clone may not contain them). A complete paired
run also needs a PostgreSQL URL, the local service can be started with
`docker compose up -d postgres`, and a real `agent-wrapper` command must replace
the generic placeholder in the manifest or be available on `PATH`. The package
script intentionally includes `--allow-exec` because it executes the reviewed
agent command:

```bash
docker compose up -d postgres
export CONTEXTENGINE_DATABASE_URL=postgresql://contextengine:contextengine@127.0.0.1:54329/contextengine
npm run eval:pr:corpus
```

This command is an orchestration entry point, not a published model result; the
checked-in corpus has no real-model experiment.

## Agent metrics contract

An adapter may write JSON to `CONTEXTENGINE_PR_EVAL_METRICS_FILE`:

```json
{
  "model": "example-model",
  "inputTokens": 12000,
  "outputTokens": 900,
  "totalTokens": 12900,
  "toolCalls": 14,
  "costUsd": 0.42
}
```

Snake-case field names are also accepted. Missing metrics remain absent from
the report; the harness does not infer token or tool counts from logs.

## Patch evidence

The report captures the agent diff before applying `testPatch`. Tracked changes
and non-ignored untracked files are included in `changedFiles`, line counts, and
the bounded `patch.diff` field. `patch.diffSha256` is present when the captured
diff is complete; `patch.diffTruncated` indicates that the configured output
limit was reached. Hidden test files therefore do not appear in the captured
patch. The diff is an audit artifact, not a substitute for OS-level execution
isolation.

## Result semantics

A run is `passed` only when the agent exits successfully, the final test command
passes, and a repository change exists when `requireChanges` is enabled. A
command that cannot be started is an infrastructure `error`, not a task
failure; infrastructure errors are excluded from paired improved/regressed
cases.
Expected changed paths are diagnostic coverage and are not used as a correctness
oracle. `git diff --check` is reported but is not a solve-rate gate.

`verifyBaseline` defaults to enabled: the final test command must fail before
the agent runs. If it already passes, the case is marked as a benchmark error
rather than a successful solve. Set it to `false` only for an intentionally
pass-to-pass case with an independently documented oracle.

## Current scope

V1 compares packed context against a prompt-only baseline and provides
repeatable execution, isolated Git repositories, deterministic test gating,
repetition-aware paired reports across all `none x packed` variants, a small
fixed historical corpus, and an
optional agent metrics contract. Dynamic MCP tool-use adapters, a broad public
PR corpus, controlled real-model trials, multiple fail-to-pass and pass-to-pass
test groups, VM-grade isolation, and model-specific JSONL usage parsers remain
follow-up work. Docker agent isolation is implemented and opt-in; host mode is
retained for backwards compatibility and trusted smoke tests.

No real-model PR benchmark result is published by this repository yet. Do not
present the V1 harness itself as evidence of quality lift or as a reproduction
of Augment's proprietary PR benchmark without matching corpus, agent, model,
prompts, budgets, repetitions, tests, and judge criteria.
