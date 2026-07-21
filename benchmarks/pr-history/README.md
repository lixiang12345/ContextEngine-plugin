# ContextEngine historical PR corpus V1

This seed corpus contains three fixed, repository-local engineering tasks from
ContextEngine's Git history. It is intended to validate the PR harness and to
support controlled baseline-versus-context experiments without downloading an
external dataset.

| Case | Base | Gold | Oracle test added by `testPatch` |
|---|---|---|---|
| `kotlin-constructor-lambda-chunking` | `772d2f8bca0e12ead21cb4b6d9c338769ebe86a8` | `2490d91cfc36b0f0e76a409ff164aecd62caad6a` | `test/pr-history-kotlin-constructor-lambda.test.ts` |
| `file-level-rerank` | `ce361c499131dfcc2421fd066753da86b8f87f47` | `6fb1e75a0cd148ab999f6111ea9d67a50097d405` | `test/pr-history-file-level-rerank.test.ts` |
| `lexical-candidate-aggregation` | `6fb1e75a0cd148ab999f6111ea9d67a50097d405` | `772d2f8bca0e12ead21cb4b6d9c338769ebe86a8` | `test/pr-history-lexical-candidate-aggregation.test.ts` |

Every committed oracle patch creates exactly the uniquely named new test file
shown above. It does not modify an existing source or test file. The patches
were checked to apply to their exact base commits. On 2026-07-21 each oracle
failed on the base commit and passed on the recorded gold commit. Gold commits
are audit references only; an evaluated sanitized workspace contains the base
commit.

## CI oracle validation

The fail-to-pass CI gate validates only the fixed test oracles; it does not run
an agent or report model quality:

```bash
npm ci
npm run eval:pr:corpus:validate
```

Run it from a full source Git clone, not a shallow checkout: all three pinned
base and gold commits must be available locally. The script exits nonzero if a
patch does not apply, its base test does not fail, or its gold test does not
pass.

## Run the paired corpus

The full 18-run corpus requires more than the oracle gate:

- a full source Git clone containing every pinned historical commit;
- a reachable PostgreSQL URL for ContextEngine, or the local service started
  with `docker compose up -d postgres`;
- an `agent-wrapper` on `PATH`, or an edited manifest pointing to a real adapter.

For the local Compose defaults:

```bash
docker compose up -d postgres
export CONTEXTENGINE_DATABASE_URL=postgresql://contextengine:contextengine@127.0.0.1:54329/contextengine
npm run eval:pr:corpus
```

`npm run eval:pr:corpus` deliberately includes `--allow-exec`; review the
manifest and adapter before running it. The checked-in `agent-wrapper` is only a
placeholder, so this repository has no completed real-model experiment.

The manifest deliberately names a generic `agent-wrapper`. Point that command
at an adapter that runs the same model, prompt policy, tool budget, and timeout
for both variants and writes the optional metrics JSON contract. Its raw task
prompt and exact agent prompt/context hashes are recorded per run. The report
also compares every `none` variant with every `packed` variant at matching
case/repetition identities. To choose explicit report paths, use:

```bash
npm run eval:pr -- \
  --manifest benchmarks/pr-history/contextengine-v1.json \
  --allow-exec \
  --out eval-results/contextengine-pr-v1.json \
  --markdown eval-results/contextengine-pr-v1.md
```

The default manifest performs 18 executions: 3 cases, 2 variants, and 3
repetitions. It is a small internal regression corpus, not a statistically
representative public benchmark and not a reproduction of Augment's private
evaluation set. No real-model result has been checked in.
