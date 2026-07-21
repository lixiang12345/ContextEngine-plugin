import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { ContextEngine } from "../engine.js";

const DEFAULT_AGENT_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 256 * 1024;
const TERMINATE_GRACE_MS = 2_000;
const DEFAULT_REPETITIONS = 1;
const MAX_REPETITIONS = 20;

export type PrEvalContextMode = "none" | "packed";
export type PrEvalRunStatus = "passed" | "failed" | "timeout" | "error";
export type PrEvalIsolationMode = "sanitized" | "shared-history";

export interface PrEvalCommandResult {
  command: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: string;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  outputTruncated: boolean;
}

export interface PrEvalAgentUsage {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  toolCalls?: number;
  costUsd?: number;
}

export interface PrEvalAgentConfig {
  command: string[];
  env?: Record<string, string>;
  timeoutMs: number;
}

export interface PrEvalContextConfig {
  mode: PrEvalContextMode;
  topK?: number;
  maxTokens?: number;
}

export interface PrEvalVariant {
  id: string;
  context: PrEvalContextConfig;
  command?: string[];
  env?: Record<string, string>;
}

export interface PrEvalCase {
  id: string;
  prompt: string;
  baseRef?: string;
  goldRef?: string;
  setupCommand?: string[];
  testCommand?: string[];
  verifyBaseline?: boolean;
  requireChanges?: boolean;
  /** Optional hidden test patch applied only for baseline/final test execution. */
  testPatch?: string;
  expectedChangedPaths?: string[];
  agentTimeoutMs?: number;
  setupTimeoutMs?: number;
  testTimeoutMs?: number;
}

export interface PrEvalSuite {
  schemaVersion: 1;
  name: string;
  repository: string;
  baseRef: string;
  isolation: PrEvalIsolationMode;
  agent: PrEvalAgentConfig;
  variants: PrEvalVariant[];
  cases: PrEvalCase[];
  setupCommand?: string[];
  testCommand?: string[];
  verifyBaseline: boolean;
  requireChanges: boolean;
  /** Number of independent executions for every case/variant pair. */
  repetitions: number;
}

export interface PreparedPrContext {
  text: string;
  estimatedTokens: number;
  hitPaths: string[];
  durationMs: number;
  truncated: boolean;
  degradedChannels?: string[];
}

export interface PrEvalContextProviderInput {
  workspace: string;
  runDirectory: string;
  workspaceId: string;
  runId: string;
  caseId: string;
  variantId: string;
  repetition: number;
  prompt: string;
  config: PrEvalContextConfig;
}

export type PrEvalContextProvider = (
  input: PrEvalContextProviderInput,
) => Promise<PreparedPrContext>;

export interface PrEvalPatchStats {
  changedFiles: string[];
  insertions: number;
  deletions: number;
  patchBytes: number;
  diff: string;
  diffSha256?: string;
  diffTruncated: boolean;
  diffCheckPassed: boolean;
  diffCheckOutput?: string;
}

export interface PrEvalRunResult {
  /** Stable identity for this exact case/variant/repetition configuration. */
  runId: string;
  caseId: string;
  variantId: string;
  /** One-based repetition number. */
  repetition: number;
  status: PrEvalRunStatus;
  baseRef: string;
  baseCommit: string;
  goldRef?: string;
  goldCommit?: string;
  /** Hash of the raw task prompt from the manifest. */
  promptSha256: string;
  /** Hash of the exact prompt file supplied to the agent. */
  agentPromptSha256?: string;
  /** Hash of the exact context file supplied to the agent. */
  contextSha256?: string;
  agentCommandSha256: string;
  finalCommit?: string;
  durationMs: number;
  setup?: PrEvalCommandResult;
  baselineSetup?: PrEvalCommandResult;
  baselineTest?: PrEvalCommandResult;
  agent?: PrEvalCommandResult;
  test?: PrEvalCommandResult;
  usage?: PrEvalAgentUsage;
  context?: Omit<PreparedPrContext, "text"> & { mode: "packed" };
  patch?: PrEvalPatchStats;
  testPatchApplied?: boolean;
  expectedPathCoverage?: number;
  failure?: {
    stage: "setup" | "baseline" | "context" | "agent" | "test" | "cleanup";
    message: string;
  };
  workspace?: string;
}

export interface PrEvalVariantSummary {
  variantId: string;
  repetitions: number;
  runs: number;
  passed: number;
  failed: number;
  timeouts: number;
  errors: number;
  passRate: number;
  meanDurationMs: number;
  p95DurationMs: number;
  meanTotalTokens?: number;
  meanToolCalls?: number;
  meanCostUsd?: number;
}

export interface PrEvalComparison {
  baselineVariantId: string;
  contextVariantId: string;
  repetitions: number;
  comparedPairs: number;
  passRateDelta: number;
  meanDurationMsDelta: number;
  meanTotalTokensDelta?: number;
  meanToolCallsDelta?: number;
  improvedCases: string[];
  regressedCases: string[];
  unchangedCases: string[];
  excludedCases: string[];
  /** Pair-level classifications use `caseId@repetition` identifiers. */
  improvedPairs: string[];
  regressedPairs: string[];
  unchangedPairs: string[];
  excludedPairs: string[];
}

export interface PrEvalReport {
  schemaVersion: 1;
  suite: {
    name: string;
    repository: string;
    generatedAt: string;
    baseRef: string;
    isolation: PrEvalIsolationMode;
    repetitions: number;
  };
  summary: {
    totalRuns: number;
    passed: number;
    failed: number;
    timeouts: number;
    errors: number;
    passRate: number;
    byVariant: PrEvalVariantSummary[];
    /** All prompt-only baseline x packed-context comparisons. */
    comparisons: PrEvalComparison[];
    /** First comparison retained for backwards compatibility. */
    comparison?: PrEvalComparison;
  };
  runs: PrEvalRunResult[];
}

export interface PrEvalProgress {
  phase: "start" | "complete";
  caseId: string;
  variantId: string;
  repetition: number;
  completedRuns: number;
  totalRuns: number;
  status?: PrEvalRunStatus;
}

export interface RunPrEvalOptions {
  caseIds?: string[];
  variantIds?: string[];
  keepWorktrees?: boolean;
  tempRoot?: string;
  outputLimitBytes?: number;
  contextProvider?: PrEvalContextProvider;
  onProgress?: (progress: PrEvalProgress) => void;
}

type JsonObject = Record<string, unknown>;

/** Parse and normalize a versioned PR-evaluation manifest. */
export function parsePrEvalSuite(
  value: unknown,
  options: { baseDirectory?: string } = {},
): PrEvalSuite {
  const raw = objectValue(value, "suite");
  assertAllowedKeys(
    raw,
    [
      "schemaVersion",
      "name",
      "repository",
      "baseRef",
      "isolation",
      "agent",
      "variants",
      "cases",
      "setupCommand",
      "testCommand",
      "verifyBaseline",
      "requireChanges",
      "repetitions",
    ],
    "suite",
  );
  const schemaVersion = raw.schemaVersion ?? 1;
  if (schemaVersion !== 1) {
    throw new Error(`Unsupported PR eval schemaVersion: ${String(schemaVersion)}`);
  }

  const name = requiredString(raw.name, "suite.name");
  const configuredRepository = requiredString(
    raw.repository,
    "suite.repository",
  );
  const repository = path.resolve(
    options.baseDirectory ?? process.cwd(),
    configuredRepository,
  );
  const baseRef = optionalString(raw.baseRef, "suite.baseRef") ?? "HEAD";
  const isolation = isolationValue(raw.isolation, "suite.isolation");
  const agentRaw = objectValue(raw.agent, "suite.agent");
  assertAllowedKeys(
    agentRaw,
    ["command", "env", "timeoutMs"],
    "suite.agent",
  );
  const agent: PrEvalAgentConfig = {
    command: commandValue(agentRaw.command, "suite.agent.command", true)!,
    env: environmentValue(agentRaw.env, "suite.agent.env"),
    timeoutMs: positiveInteger(
      agentRaw.timeoutMs,
      "suite.agent.timeoutMs",
      DEFAULT_AGENT_TIMEOUT_MS,
    ),
  };

  const defaultVariants: unknown[] = [
    { id: "baseline", context: "none" },
    { id: "contextengine", context: { mode: "packed" } },
  ];
  const variantsRaw = raw.variants ?? defaultVariants;
  if (!Array.isArray(variantsRaw) || variantsRaw.length === 0) {
    throw new Error("suite.variants must be a non-empty array");
  }
  const variants = variantsRaw.map((entry, index) =>
    parseVariant(entry, `suite.variants[${index}]`),
  );
  assertUniqueIds(variants, "suite.variants");

  if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
    throw new Error("suite.cases must be a non-empty array");
  }
  const cases = raw.cases.map((entry, index) =>
    parseCase(
      entry,
      `suite.cases[${index}]`,
      options.baseDirectory ?? process.cwd(),
    ),
  );
  assertUniqueIds(cases, "suite.cases");

  const testCommand = commandValue(
    raw.testCommand,
    "suite.testCommand",
    false,
  );
  for (const item of cases) {
    if (!item.testCommand && !testCommand) {
      throw new Error(
        `suite.cases[${item.id}] needs testCommand because suite.testCommand is absent`,
      );
    }
  }

  return {
    schemaVersion: 1,
    name,
    repository,
    baseRef,
    isolation,
    agent,
    variants,
    cases,
    setupCommand: commandValue(
      raw.setupCommand,
      "suite.setupCommand",
      false,
    ),
    testCommand,
    verifyBaseline: optionalBoolean(
      raw.verifyBaseline,
      "suite.verifyBaseline",
      true,
    ),
    requireChanges: optionalBoolean(
      raw.requireChanges,
      "suite.requireChanges",
      true,
    ),
    repetitions: repetitionCount(raw.repetitions, "suite.repetitions"),
  };
}

export function loadPrEvalSuite(filePath: string): PrEvalSuite {
  const absolutePath = path.resolve(filePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolutePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `Unable to read PR eval suite ${absolutePath}: ${errorMessage(error)}`,
    );
  }
  return parsePrEvalSuite(parsed, {
    baseDirectory: path.dirname(absolutePath),
  });
}

/** Run every selected case/variant/repetition in an isolated Git repository. */
export async function runPrEvalSuite(
  suite: PrEvalSuite,
  options: RunPrEvalOptions = {},
): Promise<PrEvalReport> {
  assertRepository(suite.repository);
  const cases = filterById(suite.cases, options.caseIds, "case");
  const variants = filterById(suite.variants, options.variantIds, "variant");
  const totalRuns = cases.length * variants.length * suite.repetitions;
  const results: PrEvalRunResult[] = [];
  const contextProvider = options.contextProvider ?? preparePackedContext;

  for (const evalCase of cases) {
    for (let repetition = 1; repetition <= suite.repetitions; repetition += 1) {
      for (const variant of variants) {
        options.onProgress?.({
          phase: "start",
          caseId: evalCase.id,
          variantId: variant.id,
          repetition,
          completedRuns: results.length,
          totalRuns,
        });
        const result = await runSingleEvaluation(
          suite,
          evalCase,
          variant,
          repetition,
          contextProvider,
          options,
        );
        results.push(result);
        options.onProgress?.({
          phase: "complete",
          caseId: evalCase.id,
          variantId: variant.id,
          repetition,
          completedRuns: results.length,
          totalRuns,
          status: result.status,
        });
      }
    }
  }

  return buildPrEvalReport(suite, results, variants);
}

export function formatPrEvalReportMarkdown(report: PrEvalReport): string {
  const lines = [
    `# PR evaluation: ${escapeMarkdown(report.suite.name)}`,
    "",
    `Generated: ${report.suite.generatedAt}`,
    `Repository: \`${escapeMarkdown(report.suite.repository)}\``,
    `Default base ref: \`${escapeMarkdown(report.suite.baseRef)}\``,
    `Isolation: \`${report.suite.isolation}\``,
    `Repetitions per case/variant: ${report.suite.repetitions}`,
    "",
    "## Summary",
    "",
    `Solved ${report.summary.passed}/${report.summary.totalRuns} runs (${formatPercent(report.summary.passRate)}).`,
    "",
    "| Variant | Repetitions | Runs | Passed | Failed | Timeout | Error | Pass rate | Mean duration | Mean tokens | Mean tools |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...report.summary.byVariant.map(
      (variant) =>
        `| ${escapeMarkdown(variant.variantId)} | ${variant.repetitions} | ${variant.runs} | ${variant.passed} | ${variant.failed} | ${variant.timeouts} | ${variant.errors} | ${formatPercent(variant.passRate)} | ${formatDuration(variant.meanDurationMs)} | ${formatOptionalNumber(variant.meanTotalTokens)} | ${formatOptionalNumber(variant.meanToolCalls)} |`,
    ),
  ];

  if (report.summary.comparisons.length > 0) {
    lines.push(
      "",
      report.summary.comparisons.length === 1
        ? "## Paired comparison"
        : "## Paired comparisons",
    );
    for (const comparison of report.summary.comparisons) {
      if (report.summary.comparisons.length > 1) {
        lines.push(
          "",
          `### ${escapeMarkdown(comparison.contextVariantId)} vs ${escapeMarkdown(comparison.baselineVariantId)}`,
        );
      }
      lines.push(
        "",
        `\`${escapeMarkdown(comparison.contextVariantId)}\` vs \`${escapeMarkdown(comparison.baselineVariantId)}\`: ${formatSignedPercent(comparison.passRateDelta)} solve-rate delta, ${formatSignedDuration(comparison.meanDurationMsDelta)} mean-duration delta across ${comparison.comparedPairs} paired run(s).`,
        "",
        `Improved cases: ${formatIdList(comparison.improvedCases)}`,
        `Regressed cases: ${formatIdList(comparison.regressedCases)}`,
        `Unchanged cases: ${formatIdList(comparison.unchangedCases)}`,
        `Excluded cases (infrastructure/benchmark error): ${formatIdList(comparison.excludedCases)}`,
        `Improved pairs: ${formatIdList(comparison.improvedPairs)}`,
        `Regressed pairs: ${formatIdList(comparison.regressedPairs)}`,
        `Unchanged pairs: ${formatIdList(comparison.unchangedPairs)}`,
        `Excluded pairs: ${formatIdList(comparison.excludedPairs)}`,
      );
    }
  }

  lines.push(
    "",
    "## Runs",
    "",
    "| Case | Rep | Variant | Base commit | Gold commit | Status | Test | Changed files | Expected path coverage | Tokens | Tools | Duration |",
    "|---|---:|---|---|---|---|---|---:|---:|---:|---:|---:|",
    ...report.runs.map((run) => {
      const test = run.test
        ? run.test.timedOut
          ? "timeout"
          : run.test.exitCode === 0
            ? "pass"
            : `exit ${String(run.test.exitCode)}`
        : "-";
      return `| ${escapeMarkdown(run.caseId)} | ${run.repetition} | ${escapeMarkdown(run.variantId)} | \`${shortCommit(run.baseCommit)}\` | ${run.goldCommit ? `\`${shortCommit(run.goldCommit)}\`` : "-"} | ${run.status} | ${test} | ${run.patch?.changedFiles.length ?? 0} | ${run.expectedPathCoverage === undefined ? "-" : formatPercent(run.expectedPathCoverage)} | ${formatOptionalNumber(run.usage?.totalTokens)} | ${formatOptionalNumber(run.usage?.toolCalls)} | ${formatDuration(run.durationMs)} |`;
    }),
    "",
  );
  return lines.join("\n");
}

async function runSingleEvaluation(
  suite: PrEvalSuite,
  evalCase: PrEvalCase,
  variant: PrEvalVariant,
  repetition: number,
  contextProvider: PrEvalContextProvider,
  options: RunPrEvalOptions,
): Promise<PrEvalRunResult> {
  const started = performance.now();
  const runId = createRunId(evalCase.id, variant.id, repetition);
  const baseRef = evalCase.baseRef ?? suite.baseRef;
  const outputLimitBytes = positiveRuntimeInteger(
    options.outputLimitBytes,
    DEFAULT_OUTPUT_LIMIT_BYTES,
  );
  const tempParent = mkdtempSync(
    path.join(
      options.tempRoot ?? tmpdir(),
      `contextengine-pr-eval-${safeRunLabel(runId)}-`,
    ),
  );
  const workspace = path.join(tempParent, "workspace");
  const runDirectory = path.join(tempParent, "run");
  mkdirSync(runDirectory, { recursive: true });

  let baseCommit = "";
  let goldCommit: string | undefined;
  let sharedWorktreeCreated = false;
  let activeStage: NonNullable<PrEvalRunResult["failure"]>["stage"] = "setup";
  let result: PrEvalRunResult | undefined;

  try {
    baseCommit = await resolveCommit(suite.repository, baseRef, outputLimitBytes);
    if (evalCase.goldRef) {
      goldCommit = await resolveCommit(
        suite.repository,
        evalCase.goldRef,
        outputLimitBytes,
      );
    }
    if (evalCase.testPatch && !existsSync(evalCase.testPatch)) {
      throw new Error(`testPatch does not exist: ${evalCase.testPatch}`);
    }
    if (suite.isolation === "sanitized") {
      await createSanitizedWorkspace(
        suite.repository,
        workspace,
        baseCommit,
        outputLimitBytes,
      );
    } else {
      const addWorktree = await runCommand(
        ["git", "worktree", "add", "--detach", workspace, baseCommit],
        {
          cwd: suite.repository,
          timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
          outputLimitBytes,
        },
      );
      if (addWorktree.exitCode !== 0) {
        throw new Error(
          `git worktree add failed: ${commandFailure(addWorktree)}`,
        );
      }
      sharedWorktreeCreated = true;
    }

    const values = createTemplateValues({
      workspace,
      runDirectory,
      evalCase,
      variant,
      repetition,
      runId,
    });
    const setupCommand = evalCase.setupCommand ?? suite.setupCommand;
    const testCommand = evalCase.testCommand ?? suite.testCommand!;
    const setup = setupCommand
      ? await runCommand(expandCommand(setupCommand, values), {
          cwd: workspace,
          timeoutMs:
            evalCase.setupTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
          outputLimitBytes,
        })
      : undefined;
    if (setup && (setup.exitCode !== 0 || setup.timedOut)) {
      result = baseResult(
        suite,
        evalCase,
        variant,
        baseRef,
        baseCommit,
        started,
        options.keepWorktrees ? workspace : undefined,
      );
      result.status = setup.timedOut ? "timeout" : "error";
      result.setup = setup;
      result.failure = {
        stage: "setup",
        message: commandFailure(setup),
      };
      return result;
    }
    const setupChanges = await collectPatchStats(
      workspace,
      baseCommit,
      outputLimitBytes,
    );
    if (setupChanges.changedFiles.length > 0) {
      result = baseResult(
        suite,
        evalCase,
        variant,
        baseRef,
        baseCommit,
        started,
        options.keepWorktrees ? workspace : undefined,
      );
      result.status = "error";
      result.setup = setup;
      result.patch = setupChanges;
      result.failure = {
        stage: "setup",
        message: `setup modified benchmark files: ${setupChanges.changedFiles.join(", ")}`,
      };
      return result;
    }

    activeStage = "baseline";
    const verifyBaseline = evalCase.verifyBaseline ?? suite.verifyBaseline;
    let baselineSetup: PrEvalCommandResult | undefined;
    let baselineTest: PrEvalCommandResult | undefined;
    if (verifyBaseline) {
      const baselineWorkspace = path.join(tempParent, "baseline-workspace");
      const baselineRunDirectory = path.join(tempParent, "baseline-run");
      mkdirSync(baselineRunDirectory, { recursive: true });
      try {
        await createSanitizedWorkspace(
          suite.repository,
          baselineWorkspace,
          baseCommit,
          outputLimitBytes,
        );
        const baselineValues = createTemplateValues({
          workspace: baselineWorkspace,
          runDirectory: baselineRunDirectory,
          evalCase,
          variant,
          repetition,
          runId: `${runId}:baseline-verification`,
        });
        baselineSetup = setupCommand
          ? await runCommand(expandCommand(setupCommand, baselineValues), {
              cwd: baselineWorkspace,
              timeoutMs:
                evalCase.setupTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
              outputLimitBytes,
            })
          : undefined;
        if (
          baselineSetup &&
          (baselineSetup.exitCode !== 0 || baselineSetup.timedOut)
        ) {
          result = baseResult(
            suite,
            evalCase,
            variant,
            baseRef,
            baseCommit,
            started,
            options.keepWorktrees ? workspace : undefined,
          );
          result.status = baselineSetup.timedOut ? "timeout" : "error";
          result.setup = setup;
          result.baselineSetup = baselineSetup;
          result.failure = {
            stage: "baseline",
            message: baselineSetup.timedOut
              ? "baseline setup timed out"
              : `baseline setup failed: ${commandFailure(baselineSetup)}`,
          };
          return result;
        }
        const baselineSetupChanges = await collectPatchStats(
          baselineWorkspace,
          baseCommit,
          outputLimitBytes,
        );
        if (baselineSetupChanges.changedFiles.length > 0) {
          result = baseResult(
            suite,
            evalCase,
            variant,
            baseRef,
            baseCommit,
            started,
            options.keepWorktrees ? workspace : undefined,
          );
          result.status = "error";
          result.setup = setup;
          result.baselineSetup = baselineSetup;
          result.patch = baselineSetupChanges;
          result.failure = {
            stage: "baseline",
            message: `baseline setup modified benchmark files: ${baselineSetupChanges.changedFiles.join(", ")}`,
          };
          return result;
        }
        if (evalCase.testPatch) {
          const applied = await applyTestPatch(
            baselineWorkspace,
            evalCase.testPatch,
            false,
            outputLimitBytes,
          );
          if (applied.exitCode !== 0) {
            result = baseResult(
              suite,
              evalCase,
              variant,
              baseRef,
              baseCommit,
              started,
              options.keepWorktrees ? workspace : undefined,
            );
            result.status = "error";
            result.setup = setup;
            result.baselineSetup = baselineSetup;
            result.failure = {
              stage: "baseline",
              message: `unable to apply baseline test patch: ${commandFailure(applied)}`,
            };
            return result;
          }
        }
        baselineTest = await runCommand(
          expandCommand(testCommand, baselineValues),
          {
            cwd: baselineWorkspace,
            timeoutMs: evalCase.testTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
            outputLimitBytes,
          },
        );
        if (evalCase.testPatch) {
          const reverted = await applyTestPatch(
            baselineWorkspace,
            evalCase.testPatch,
            true,
            outputLimitBytes,
          );
          if (reverted.exitCode !== 0) {
            result = baseResult(
              suite,
              evalCase,
              variant,
              baseRef,
              baseCommit,
              started,
              options.keepWorktrees ? workspace : undefined,
            );
            result.status = "error";
            result.setup = setup;
            result.baselineSetup = baselineSetup;
            result.baselineTest = baselineTest;
            result.failure = {
              stage: "baseline",
              message: `unable to remove baseline test patch: ${commandFailure(reverted)}`,
            };
            return result;
          }
        }
        if (
          baselineTest.spawnError ||
          (baselineTest.signal && !baselineTest.timedOut)
        ) {
          result = baseResult(
            suite,
            evalCase,
            variant,
            baseRef,
            baseCommit,
            started,
            options.keepWorktrees ? workspace : undefined,
          );
          result.status = "error";
          result.setup = setup;
          result.baselineSetup = baselineSetup;
          result.baselineTest = baselineTest;
          result.failure = {
            stage: "baseline",
            message: `baseline verification could not run: ${commandFailure(baselineTest)}`,
          };
          return result;
        }
        if (baselineTest.timedOut || baselineTest.exitCode === 0) {
          result = baseResult(
            suite,
            evalCase,
            variant,
            baseRef,
            baseCommit,
            started,
            options.keepWorktrees ? workspace : undefined,
          );
          result.status = baselineTest.timedOut ? "timeout" : "error";
          result.setup = setup;
          result.baselineSetup = baselineSetup;
          result.baselineTest = baselineTest;
          result.failure = {
            stage: "baseline",
            message: baselineTest.timedOut
              ? "baseline verification timed out"
              : "benchmark is invalid because the test already passes before the agent runs",
          };
          return result;
        }
        const baselineChanges = await collectPatchStats(
          baselineWorkspace,
          baseCommit,
          outputLimitBytes,
        );
        if (baselineChanges.changedFiles.length > 0) {
          result = baseResult(
            suite,
            evalCase,
            variant,
            baseRef,
            baseCommit,
            started,
            options.keepWorktrees ? workspace : undefined,
          );
          result.status = "error";
          result.setup = setup;
          result.baselineSetup = baselineSetup;
          result.baselineTest = baselineTest;
          result.patch = baselineChanges;
          result.failure = {
            stage: "baseline",
            message: `baseline verification left repository changes: ${baselineChanges.changedFiles.join(", ")}`,
          };
          return result;
        }
      } finally {
        rmSync(baselineWorkspace, { recursive: true, force: true });
        rmSync(baselineRunDirectory, { recursive: true, force: true });
      }
    }

    activeStage = "context";
    let preparedContext: PreparedPrContext | undefined;
    if (variant.context.mode === "packed") {
      try {
        preparedContext = await contextProvider({
          workspace,
          runDirectory,
          workspaceId: `pr-eval-${randomUUID()}`,
          runId,
          caseId: evalCase.id,
          variantId: variant.id,
          repetition,
          prompt: evalCase.prompt,
          config: variant.context,
        });
      } catch (error) {
        result = baseResult(
          suite,
          evalCase,
          variant,
          baseRef,
          baseCommit,
          started,
          options.keepWorktrees ? workspace : undefined,
        );
        result.status = "error";
        result.setup = setup;
        result.baselineSetup = baselineSetup;
        result.baselineTest = baselineTest;
        result.failure = {
          stage: "context",
          message: errorMessage(error),
        };
        return result;
      }
    }

    activeStage = "agent";
    const promptFile = values.prompt_file;
    const contextFile = values.context_file;
    const contextText = preparedContext?.text ?? "";
    const agentPrompt = composeAgentPrompt(evalCase.prompt, contextText);
    const promptEvidence = {
      agentPromptSha256: sha256(agentPrompt),
      contextSha256: sha256(contextText),
    };
    writeFileSync(contextFile, contextText, "utf8");
    writeFileSync(promptFile, agentPrompt, "utf8");

    const command = expandCommand(
      variant.command ?? suite.agent.command,
      values,
    );
    const agent = await runCommand(command, {
      cwd: workspace,
      timeoutMs:
        evalCase.agentTimeoutMs ?? suite.agent.timeoutMs,
      outputLimitBytes,
      env: {
        ...suite.agent.env,
        ...variant.env,
        CONTEXTENGINE_PR_EVAL_CASE_ID: evalCase.id,
        CONTEXTENGINE_PR_EVAL_VARIANT_ID: variant.id,
        CONTEXTENGINE_PR_EVAL_REPETITION: String(repetition),
        CONTEXTENGINE_PR_EVAL_RUN_ID: runId,
        CONTEXTENGINE_PR_EVAL_WORKSPACE: workspace,
        CONTEXTENGINE_PR_EVAL_PROMPT_FILE: promptFile,
        CONTEXTENGINE_PR_EVAL_CONTEXT_FILE: contextFile,
        CONTEXTENGINE_PR_EVAL_METRICS_FILE: values.metrics_file,
        CONTEXTENGINE_PR_EVAL_CONTEXT_MODE: variant.context.mode,
      },
    });
    const usage = readAgentUsage(values.metrics_file);
    const patch = await collectPatchStats(
      workspace,
      baseCommit,
      outputLimitBytes,
    );
    if (agent.spawnError) {
      result = {
        ...baseResult(
          suite,
          evalCase,
          variant,
          baseRef,
          baseCommit,
          started,
          options.keepWorktrees ? workspace : undefined,
        ),
        status: "error",
        ...promptEvidence,
        setup,
        baselineSetup,
        baselineTest,
        agent,
        usage,
        patch,
        failure: {
          stage: "agent",
          message: commandFailure(agent),
        },
      };
      return result;
    }
    activeStage = "test";
    let testPatchApplied = false;
    if (evalCase.testPatch) {
      const applied = await applyTestPatch(
        workspace,
        evalCase.testPatch,
        false,
        outputLimitBytes,
      );
      if (applied.exitCode !== 0) {
        result = {
          ...baseResult(
            suite,
            evalCase,
            variant,
            baseRef,
            baseCommit,
            started,
            options.keepWorktrees ? workspace : undefined,
          ),
          status: "error",
          ...promptEvidence,
          setup,
          baselineSetup,
          baselineTest,
          agent,
          usage,
          patch,
          failure: {
            stage: "test",
            message: `unable to apply final test patch: ${commandFailure(applied)}`,
          },
        };
        return result;
      }
      testPatchApplied = true;
    }
    const test = await runCommand(expandCommand(testCommand, values), {
      cwd: workspace,
      timeoutMs: evalCase.testTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      outputLimitBytes,
    });
    const expectedPathCoverage = pathCoverage(
      patch.changedFiles,
      evalCase.expectedChangedPaths,
    );
    const requireChanges = evalCase.requireChanges ?? suite.requireChanges;
    const passed =
      !agent.timedOut &&
      agent.exitCode === 0 &&
      !agent.spawnError &&
      !test.timedOut &&
      test.exitCode === 0 &&
      !test.spawnError &&
      (!requireChanges || patch.changedFiles.length > 0);
    const timedOut = agent.timedOut || test.timedOut;
    const infrastructureError = Boolean(test.spawnError);

    result = {
      ...baseResult(
        suite,
        evalCase,
        variant,
        baseRef,
        baseCommit,
        started,
        options.keepWorktrees ? workspace : undefined,
      ),
      status: infrastructureError
        ? "error"
        : timedOut
          ? "timeout"
            : passed
              ? "passed"
              : "failed",
      ...promptEvidence,
      setup,
      baselineSetup,
      baselineTest,
      agent,
      test,
      usage,
      context: preparedContext
        ? {
            mode: "packed",
            estimatedTokens: preparedContext.estimatedTokens,
            hitPaths: preparedContext.hitPaths,
            durationMs: preparedContext.durationMs,
            truncated: preparedContext.truncated,
            degradedChannels: preparedContext.degradedChannels,
          }
        : undefined,
      patch,
      testPatchApplied,
      expectedPathCoverage,
      finalCommit: await currentCommit(workspace, outputLimitBytes),
    };
    if (!passed) {
      result.failure = {
        stage:
          agent.exitCode !== 0 || agent.timedOut || agent.spawnError
            ? "agent"
            : "test",
        message: test.spawnError
          ? commandFailure(test)
          : timedOut
            ? "agent or test command timed out"
            : requireChanges && patch.changedFiles.length === 0
              ? "agent produced no repository changes"
              : agent.exitCode !== 0
                ? commandFailure(agent)
                : commandFailure(test),
      };
    }
    return result;
  } catch (error) {
    result = baseResult(
      suite,
      evalCase,
      variant,
      baseRef,
      baseCommit,
      started,
      options.keepWorktrees ? workspace : undefined,
    );
    result.status = "error";
    result.failure = { stage: activeStage, message: errorMessage(error) };
    return result;
  } finally {
    if (result) {
      result.runId = runId;
      result.repetition = repetition;
      result.goldRef = evalCase.goldRef;
      result.goldCommit = goldCommit;
    }
    if (sharedWorktreeCreated && !options.keepWorktrees) {
      const cleanup = await runCommand(
        ["git", "worktree", "remove", "--force", workspace],
        {
          cwd: suite.repository,
          timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
          outputLimitBytes,
        },
      );
      if (
        cleanup.spawnError ||
        cleanup.timedOut ||
        cleanup.exitCode !== 0
      ) {
        const previousStatus = result?.status;
        const previousFailure = result?.failure?.message;
        if (result) {
          result.status = "error";
          result.failure = {
            stage: "cleanup",
            message: [
              `unable to remove shared-history worktree: ${commandFailure(cleanup)}`,
              previousStatus
                ? `run status before cleanup: ${previousStatus}${previousFailure ? ` (${previousFailure})` : ""}`
                : undefined,
            ]
              .filter(Boolean)
              .join("; "),
          };
        }
      }
    }
    if (!options.keepWorktrees) {
      rmSync(tempParent, { recursive: true, force: true });
    }
    if (result) result.durationMs = elapsedMs(started);
  }
}

async function preparePackedContext(
  input: PrEvalContextProviderInput,
): Promise<PreparedPrContext> {
  const started = performance.now();
  const engine = ContextEngine.open({
    root: input.workspace,
    workspaceId: input.workspaceId,
    dataDir: path.join(input.runDirectory, "index"),
  });
  try {
    await engine.index();
    const packed = await engine.getTaskContext({
      task: input.prompt,
      topK: input.config.topK ?? 20,
      maxTokens: input.config.maxTokens ?? 12_000,
      diversify: true,
    });
    return {
      text: packed.packedText,
      estimatedTokens: packed.estimatedTokens,
      hitPaths: [...new Set(packed.hits.map((hit) => hit.chunk.path))],
      durationMs: elapsedMs(started),
      truncated: packed.truncated,
      degradedChannels: packed.degradedChannels,
    };
  } finally {
    try {
      await engine.clearIndex();
    } catch {
      // A failed index may not have created a workspace namespace to clear.
    }
    await engine.close();
  }
}

interface RunCommandOptions {
  cwd: string;
  timeoutMs: number;
  outputLimitBytes: number;
  env?: Record<string, string>;
}

/** Execute an argv command without a shell and with bounded output capture. */
export async function runPrEvalCommand(
  command: string[],
  options: RunCommandOptions,
): Promise<PrEvalCommandResult> {
  return runCommand(command, options);
}

async function runCommand(
  command: string[],
  options: RunCommandOptions,
): Promise<PrEvalCommandResult> {
  if (!command.length || !command[0]) {
    throw new Error("command must contain an executable");
  }
  const started = performance.now();
  const stdout = new BoundedCapture(options.outputLimitBytes);
  const stderr = new BoundedCapture(options.outputLimitBytes);

  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    const isolatedProcessGroup = process.platform !== "win32";
    const child = spawn(command[0], command.slice(1), {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false,
      detached: isolatedProcessGroup,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (chunk: Buffer | string) => stdout.add(chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => stderr.add(chunk));

    const finish = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
      spawnError?: Error,
    ): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceTimer) clearTimeout(forceTimer);
      if (spawnError) stderr.add(spawnError.message);
      resolve({
        command,
        exitCode,
        signal,
        spawnError: spawnError?.message,
        timedOut,
        durationMs: elapsedMs(started),
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutBytes: stdout.totalBytes,
        stderrBytes: stderr.totalBytes,
        outputTruncated: stdout.truncated || stderr.truncated,
      });
    };

    child.once("error", (error) => {
      killProcessTree(child.pid, "SIGKILL", child.kill.bind(child));
      finish(null, null, error);
    });
    child.once("close", (code, signal) => {
      // A command that exits normally may still leave background children in
      // its detached process group. They must not overlap patch capture/tests.
      killProcessTree(child.pid, "SIGKILL", child.kill.bind(child));
      finish(code, signal);
    });
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid, "SIGTERM", child.kill.bind(child));
      forceTimer = setTimeout(
        () => killProcessTree(child.pid, "SIGKILL", child.kill.bind(child)),
        TERMINATE_GRACE_MS,
      );
    }, options.timeoutMs);
  });
}

function killProcessTree(
  pid: number | undefined,
  signal: NodeJS.Signals,
  fallback: (signal?: NodeJS.Signals | number) => boolean,
): void {
  if (pid && process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // The process group may already be gone between two lifecycle events.
    }
  }
  try {
    fallback(signal);
  } catch {
    // Process already exited.
  }
}

class BoundedCapture {
  readonly chunks: Buffer[] = [];
  totalBytes = 0;
  capturedBytes = 0;
  truncated = false;

  constructor(private readonly limitBytes: number) {}

  add(value: Buffer | string): void {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
    this.totalBytes += buffer.length;
    const remaining = Math.max(0, this.limitBytes - this.capturedBytes);
    if (remaining > 0) {
      const captured = buffer.subarray(0, remaining);
      this.chunks.push(captured);
      this.capturedBytes += captured.length;
    }
    if (buffer.length > remaining) this.truncated = true;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function parseVariant(value: unknown, label: string): PrEvalVariant {
  const raw = objectValue(value, label);
  assertAllowedKeys(raw, ["id", "context", "command", "env"], label);
  const id = identifierValue(raw.id, `${label}.id`);
  const context = contextValue(raw.context, `${label}.context`);
  return {
    id,
    context,
    command: commandValue(raw.command, `${label}.command`, false),
    env: environmentValue(raw.env, `${label}.env`),
  };
}

function parseCase(
  value: unknown,
  label: string,
  baseDirectory: string,
): PrEvalCase {
  const raw = objectValue(value, label);
  assertAllowedKeys(
    raw,
    [
      "id",
      "prompt",
      "baseRef",
      "goldRef",
      "setupCommand",
      "testCommand",
      "verifyBaseline",
      "requireChanges",
      "testPatch",
      "expectedChangedPaths",
      "agentTimeoutMs",
      "setupTimeoutMs",
      "testTimeoutMs",
    ],
    label,
  );
  const testPatch = optionalString(raw.testPatch, `${label}.testPatch`);
  return {
    id: identifierValue(raw.id, `${label}.id`),
    prompt: requiredString(raw.prompt, `${label}.prompt`),
    baseRef: optionalString(raw.baseRef, `${label}.baseRef`),
    goldRef: optionalString(raw.goldRef, `${label}.goldRef`),
    setupCommand: commandValue(
      raw.setupCommand,
      `${label}.setupCommand`,
      false,
    ),
    testCommand: commandValue(
      raw.testCommand,
      `${label}.testCommand`,
      false,
    ),
    verifyBaseline: optionalBooleanValue(
      raw.verifyBaseline,
      `${label}.verifyBaseline`,
    ),
    requireChanges: optionalBooleanValue(
      raw.requireChanges,
      `${label}.requireChanges`,
    ),
    testPatch: testPatch
      ? path.resolve(baseDirectory, testPatch)
      : undefined,
    expectedChangedPaths: stringArrayValue(
      raw.expectedChangedPaths,
      `${label}.expectedChangedPaths`,
    ),
    agentTimeoutMs: optionalPositiveInteger(
      raw.agentTimeoutMs,
      `${label}.agentTimeoutMs`,
    ),
    setupTimeoutMs: optionalPositiveInteger(
      raw.setupTimeoutMs,
      `${label}.setupTimeoutMs`,
    ),
    testTimeoutMs: optionalPositiveInteger(
      raw.testTimeoutMs,
      `${label}.testTimeoutMs`,
    ),
  };
}

function isolationValue(value: unknown, label: string): PrEvalIsolationMode {
  if (value === undefined) return "sanitized";
  if (value !== "sanitized" && value !== "shared-history") {
    throw new Error(`${label} must be \"sanitized\" or \"shared-history\"`);
  }
  return value;
}

function contextValue(value: unknown, label: string): PrEvalContextConfig {
  if (value === undefined || value === "none") return { mode: "none" };
  if (value === "packed") return { mode: "packed" };
  const raw = objectValue(value, label);
  assertAllowedKeys(raw, ["mode", "topK", "maxTokens"], label);
  const mode = requiredString(raw.mode, `${label}.mode`);
  if (mode !== "none" && mode !== "packed") {
    throw new Error(`${label}.mode must be \"none\" or \"packed\"`);
  }
  return {
    mode,
    topK: optionalPositiveInteger(raw.topK, `${label}.topK`),
    maxTokens: optionalPositiveInteger(raw.maxTokens, `${label}.maxTokens`),
  };
}

function objectValue(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function assertAllowedKeys(
  value: JsonObject,
  allowed: string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length) {
    throw new Error(`${label} has unknown field(s): ${unknown.join(", ")}`);
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}

function identifierValue(value: unknown, label: string): string {
  const id = requiredString(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error(`${label} must contain only letters, numbers, dot, underscore, or hyphen`);
  }
  return id;
}

function commandValue(
  value: unknown,
  label: string,
  required: boolean,
): string[] | undefined {
  if (value === undefined && !required) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || !entry)
  ) {
    throw new Error(`${label} must be a non-empty argv string array`);
  }
  return value as string[];
}

function environmentValue(
  value: unknown,
  label: string,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const raw = objectValue(value, label);
  const entries = Object.entries(raw);
  if (entries.some(([, entry]) => typeof entry !== "string")) {
    throw new Error(`${label} values must all be strings`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function stringArrayValue(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return value.map((entry) => (entry as string).trim());
}

function optionalBoolean(
  value: unknown,
  label: string,
  fallback: boolean,
): boolean {
  return optionalBooleanValue(value, label) ?? fallback;
}

function optionalBooleanValue(
  value: unknown,
  label: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function positiveInteger(
  value: unknown,
  label: string,
  fallback: number,
): number {
  return optionalPositiveInteger(value, label) ?? fallback;
}

function repetitionCount(value: unknown, label: string): number {
  const repetitions = positiveInteger(value, label, DEFAULT_REPETITIONS);
  if (repetitions > MAX_REPETITIONS) {
    throw new Error(`${label} must not exceed ${MAX_REPETITIONS}`);
  }
  return repetitions;
}

function optionalPositiveInteger(
  value: unknown,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value as number;
}

function positiveRuntimeInteger(
  value: number | undefined,
  fallback: number,
): number {
  return Number.isInteger(value) && value! > 0 ? value! : fallback;
}

function assertUniqueIds(
  values: Array<{ id: string }>,
  label: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.id)) throw new Error(`${label} has duplicate id ${value.id}`);
    seen.add(value.id);
  }
}

function filterById<T extends { id: string }>(
  values: T[],
  selectedIds: string[] | undefined,
  label: string,
): T[] {
  if (!selectedIds?.length) return values;
  const selected = new Set(selectedIds);
  const unknown = [...selected].filter(
    (id) => !values.some((value) => value.id === id),
  );
  if (unknown.length) throw new Error(`Unknown ${label} id: ${unknown.join(", ")}`);
  return values.filter((value) => selected.has(value.id));
}

function assertRepository(repository: string): void {
  if (!existsSync(repository) || !statSync(repository).isDirectory()) {
    throw new Error(`PR eval repository does not exist: ${repository}`);
  }
}

async function resolveCommit(
  repository: string,
  ref: string,
  outputLimitBytes: number,
): Promise<string> {
  const result = await runCommand(
    ["git", "rev-parse", "--verify", `${ref}^{commit}`],
    {
      cwd: repository,
      timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
      outputLimitBytes,
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(`Unable to resolve baseRef ${ref}: ${commandFailure(result)}`);
  }
  return result.stdout.trim();
}

async function createSanitizedWorkspace(
  repository: string,
  workspace: string,
  baseCommit: string,
  outputLimitBytes: number,
): Promise<void> {
  mkdirSync(workspace, { recursive: true });
  const commands = [
    ["git", "init", "--quiet"],
    [
      "git",
      "fetch",
      "--quiet",
      "--depth",
      "1",
      "--no-tags",
      repository,
      baseCommit,
    ],
    ["git", "checkout", "--quiet", "--detach", "FETCH_HEAD"],
  ];
  for (const command of commands) {
    const result = await runCommand(command, {
      cwd: workspace,
      timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
      outputLimitBytes,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `Unable to create sanitized workspace: ${commandFailure(result)}`,
      );
    }
  }
  rmSync(path.join(workspace, ".git", "FETCH_HEAD"), { force: true });
}

async function currentCommit(
  workspace: string,
  outputLimitBytes: number,
): Promise<string | undefined> {
  const result = await runCommand(["git", "rev-parse", "HEAD"], {
    cwd: workspace,
    timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    outputLimitBytes,
  });
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

async function applyTestPatch(
  workspace: string,
  patchFile: string,
  reverse: boolean,
  outputLimitBytes: number,
): Promise<PrEvalCommandResult> {
  return runCommand(
    [
      "git",
      "apply",
      "--whitespace=nowarn",
      ...(reverse ? ["--reverse"] : []),
      patchFile,
    ],
    {
      cwd: workspace,
      timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
      outputLimitBytes,
    },
  );
}

async function collectPatchStats(
  workspace: string,
  baseCommit: string,
  outputLimitBytes: number,
): Promise<PrEvalPatchStats> {
  const indexPath = path.join(
    path.dirname(workspace),
    `patch-index-${randomUUID()}`,
  );
  const env = { GIT_INDEX_FILE: indexPath };
  const commandOptions = {
    cwd: workspace,
    timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    outputLimitBytes,
    env,
  };

  try {
    const readTree = await runCommand(
      ["git", "read-tree", baseCommit],
      commandOptions,
    );
    assertCommandCompleted(readTree, "prepare patch index");
    const add = await runCommand(
      ["git", "add", "-A", "--", "."],
      commandOptions,
    );
    assertCommandCompleted(add, "snapshot patch files");

    const [names, numstat, patch, diffCheck] = await Promise.all([
      runCommand(
        ["git", "diff", "--cached", "--name-only", "-z", baseCommit],
        commandOptions,
      ),
      runCommand(
        ["git", "diff", "--cached", "--numstat", baseCommit],
        commandOptions,
      ),
      runCommand(
        ["git", "diff", "--cached", "--binary", baseCommit],
        commandOptions,
      ),
      runCommand(
        ["git", "diff", "--cached", "--check", baseCommit],
        commandOptions,
      ),
    ]);
    assertCommandCompleted(names, "list patch files");
    assertCommandCompleted(numstat, "calculate patch line statistics");
    assertCommandCompleted(patch, "capture patch");
    if (
      diffCheck.spawnError ||
      diffCheck.timedOut ||
      diffCheck.exitCode === null
    ) {
      throw new Error(`Unable to check patch: ${commandFailure(diffCheck)}`);
    }

    let insertions = 0;
    let deletions = 0;
    for (const line of numstat.stdout.split("\n")) {
      const [added, removed] = line.split("\t", 3);
      if (/^\d+$/.test(added ?? "")) insertions += Number(added);
      if (/^\d+$/.test(removed ?? "")) deletions += Number(removed);
    }
    return {
      changedFiles: nulList(names.stdout),
      insertions,
      deletions,
      patchBytes: patch.stdoutBytes,
      diff: patch.stdout,
      diffSha256: patch.outputTruncated ? undefined : sha256(patch.stdout),
      diffTruncated: patch.outputTruncated,
      diffCheckPassed: diffCheck.exitCode === 0,
      diffCheckOutput:
        diffCheck.exitCode === 0
          ? undefined
          : [diffCheck.stdout, diffCheck.stderr].filter(Boolean).join("\n"),
    };
  } finally {
    rmSync(indexPath, { force: true });
    rmSync(`${indexPath}.lock`, { force: true });
  }
}

function assertCommandCompleted(
  result: PrEvalCommandResult,
  operation: string,
): void {
  if (result.spawnError || result.timedOut || result.exitCode !== 0) {
    throw new Error(`Unable to ${operation}: ${commandFailure(result)}`);
  }
}

function nulList(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

function pathCoverage(
  changedFiles: string[],
  expectedPaths: string[] | undefined,
): number | undefined {
  if (!expectedPaths?.length) return undefined;
  const normalized = changedFiles.map(normalizePath);
  const hits = expectedPaths.filter((expected) => {
    const target = normalizePath(expected);
    return normalized.some(
      (changed) =>
        changed === target ||
        changed.endsWith(`/${target}`) ||
        changed.includes(target),
    );
  }).length;
  return hits / expectedPaths.length;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function createTemplateValues(input: {
  workspace: string;
  runDirectory: string;
  evalCase: PrEvalCase;
  variant: PrEvalVariant;
  repetition: number;
  runId: string;
}): Record<string, string> {
  const suffix = `r${input.repetition}`;
  return {
    workspace: input.workspace,
    run_directory: input.runDirectory,
    prompt_file: path.join(input.runDirectory, `prompt-${suffix}.md`),
    context_file: path.join(input.runDirectory, `context-${suffix}.md`),
    metrics_file: path.join(input.runDirectory, `agent-metrics-${suffix}.json`),
    case_id: input.evalCase.id,
    variant_id: input.variant.id,
    repetition: String(input.repetition),
    run_id: input.runId,
  };
}

function expandCommand(
  command: string[],
  values: Record<string, string>,
): string[] {
  return command.map((argument) =>
    argument.replace(/\{([a-z_]+)\}/gi, (match, key: string) =>
      Object.hasOwn(values, key) ? values[key] : match,
    ),
  );
}

function composeAgentPrompt(task: string, context: string | undefined): string {
  if (!context) return `${task.trim()}\n`;
  return [
    task.trim(),
    "",
    "# ContextEngine evidence",
    "",
    context.trim(),
    "",
  ].join("\n");
}

function readAgentUsage(filePath: string): PrEvalAgentUsage | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    const raw = objectValue(
      JSON.parse(readFileSync(filePath, "utf8")) as unknown,
      "agent metrics",
    );
    const usage: PrEvalAgentUsage = {
      model: typeof raw.model === "string" ? raw.model : undefined,
      inputTokens: metricNumber(raw.inputTokens ?? raw.input_tokens),
      outputTokens: metricNumber(raw.outputTokens ?? raw.output_tokens),
      totalTokens: metricNumber(raw.totalTokens ?? raw.total_tokens),
      toolCalls: metricNumber(raw.toolCalls ?? raw.tool_calls, true),
      costUsd: metricNumber(raw.costUsd ?? raw.cost_usd),
    };
    if (
      usage.totalTokens === undefined &&
      usage.inputTokens !== undefined &&
      usage.outputTokens !== undefined
    ) {
      usage.totalTokens = usage.inputTokens + usage.outputTokens;
    }
    return Object.values(usage).some((value) => value !== undefined)
      ? usage
      : undefined;
  } catch {
    return undefined;
  }
}

function metricNumber(value: unknown, integer = false): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return integer ? Math.floor(value) : value;
}

function baseResult(
  suite: PrEvalSuite,
  evalCase: PrEvalCase,
  variant: PrEvalVariant,
  baseRef: string,
  baseCommit: string,
  started: number,
  workspace: string | undefined,
): PrEvalRunResult {
  return {
    runId: createRunId(evalCase.id, variant.id, 1),
    caseId: evalCase.id,
    variantId: variant.id,
    repetition: 1,
    status: "error",
    baseRef,
    baseCommit,
    promptSha256: sha256(evalCase.prompt),
    agentCommandSha256: sha256(
      JSON.stringify(variant.command ?? suite.agent.command),
    ),
    durationMs: elapsedMs(started),
    workspace,
  };
}

function createRunId(
  caseId: string,
  variantId: string,
  repetition: number,
): string {
  return `${caseId}@${repetition}:${variantId}`;
}

function safeRunLabel(runId: string): string {
  return runId.replaceAll(/[^A-Za-z0-9._-]/g, "-");
}

function buildPrEvalReport(
  suite: PrEvalSuite,
  runs: PrEvalRunResult[],
  variants: PrEvalVariant[],
): PrEvalReport {
  const byVariant = variants.map((variant) =>
    summarizeVariant(
      variant.id,
      runs.filter((run) => run.variantId === variant.id),
    ),
  );
  const baselines = variants.filter((variant) => variant.context.mode === "none");
  const contexts = variants.filter((variant) => variant.context.mode === "packed");
  const comparisons = baselines.flatMap((baseline) =>
    contexts.map((context) =>
      compareVariants(
        baseline.id,
        context.id,
        suite.repetitions,
        runs,
      ),
    ),
  );
  const passed = runs.filter((run) => run.status === "passed").length;
  return {
    schemaVersion: 1,
    suite: {
      name: suite.name,
      repository: suite.repository,
      generatedAt: new Date().toISOString(),
      baseRef: suite.baseRef,
      isolation: suite.isolation,
      repetitions: suite.repetitions,
    },
    summary: {
      totalRuns: runs.length,
      passed,
      failed: runs.filter((run) => run.status === "failed").length,
      timeouts: runs.filter((run) => run.status === "timeout").length,
      errors: runs.filter((run) => run.status === "error").length,
      passRate: runs.length ? passed / runs.length : 0,
      byVariant,
      comparisons,
      comparison: comparisons[0],
    },
    runs,
  };
}

function summarizeVariant(
  variantId: string,
  runs: PrEvalRunResult[],
): PrEvalVariantSummary {
  const durations = runs.map((run) => run.durationMs);
  const passed = runs.filter((run) => run.status === "passed").length;
  return {
    variantId,
    repetitions: new Set(runs.map((run) => run.repetition)).size,
    runs: runs.length,
    passed,
    failed: runs.filter((run) => run.status === "failed").length,
    timeouts: runs.filter((run) => run.status === "timeout").length,
    errors: runs.filter((run) => run.status === "error").length,
    passRate: runs.length ? passed / runs.length : 0,
    meanDurationMs: mean(durations) ?? 0,
    p95DurationMs: percentile(durations, 0.95),
    meanTotalTokens: mean(
      runs.flatMap((run) =>
        run.usage?.totalTokens === undefined ? [] : [run.usage.totalTokens],
      ),
    ),
    meanToolCalls: mean(
      runs.flatMap((run) =>
        run.usage?.toolCalls === undefined ? [] : [run.usage.toolCalls],
      ),
    ),
    meanCostUsd: mean(
      runs.flatMap((run) =>
        run.usage?.costUsd === undefined ? [] : [run.usage.costUsd],
      ),
    ),
  };
}

function compareVariants(
  baselineId: string,
  contextId: string,
  repetitions: number,
  runs: PrEvalRunResult[],
): PrEvalComparison {
  const baselineRuns = new Map(
    runs
      .filter((run) => run.variantId === baselineId)
      .map((run) => [pairedRunKey(run), run]),
  );
  const contextRuns = new Map(
    runs
      .filter((run) => run.variantId === contextId)
      .map((run) => [pairedRunKey(run), run]),
  );
  const sharedPairs = [...baselineRuns.keys()].filter((key) =>
    contextRuns.has(key),
  );
  const comparablePairs = sharedPairs.filter(
    (key) =>
      comparisonOutcome(baselineRuns.get(key)!) !== undefined &&
      comparisonOutcome(contextRuns.get(key)!) !== undefined,
  );
  const baselineComparable = comparablePairs.map(
    (key) => baselineRuns.get(key)!,
  );
  const contextComparable = comparablePairs.map(
    (key) => contextRuns.get(key)!,
  );
  const baselinePassRate = comparablePairs.length
    ? baselineComparable.filter((run) => comparisonOutcome(run)).length /
      comparablePairs.length
    : 0;
  const contextPassRate = comparablePairs.length
    ? contextComparable.filter((run) => comparisonOutcome(run)).length /
      comparablePairs.length
    : 0;
  const improvedPairs = comparablePairs.filter(
    (key) =>
      !comparisonOutcome(baselineRuns.get(key)!) &&
      comparisonOutcome(contextRuns.get(key)!),
  );
  const regressedPairs = comparablePairs.filter(
    (key) =>
      comparisonOutcome(baselineRuns.get(key)!) &&
      !comparisonOutcome(contextRuns.get(key)!),
  );
  const unchangedPairs = comparablePairs.filter(
    (key) =>
      comparisonOutcome(baselineRuns.get(key)!) ===
      comparisonOutcome(contextRuns.get(key)!),
  );
  const excludedPairs = sharedPairs.filter(
    (key) => !comparablePairs.includes(key),
  );
  const caseOutcomes = summarizeCaseOutcomes(
    sharedPairs,
    comparablePairs,
    baselineRuns,
    contextRuns,
  );
  return {
    baselineVariantId: baselineId,
    contextVariantId: contextId,
    repetitions,
    comparedPairs: comparablePairs.length,
    passRateDelta: contextPassRate - baselinePassRate,
    meanDurationMsDelta: meanPairedMetricDelta(
      comparablePairs,
      baselineRuns,
      contextRuns,
      (run) => run.durationMs,
    ) ?? 0,
    meanTotalTokensDelta: meanPairedMetricDelta(
      comparablePairs,
      baselineRuns,
      contextRuns,
      (run) => run.usage?.totalTokens,
    ),
    meanToolCallsDelta: meanPairedMetricDelta(
      comparablePairs,
      baselineRuns,
      contextRuns,
      (run) => run.usage?.toolCalls,
    ),
    improvedCases: caseOutcomes.improved,
    regressedCases: caseOutcomes.regressed,
    unchangedCases: caseOutcomes.unchanged,
    excludedCases: caseOutcomes.excluded,
    improvedPairs,
    regressedPairs,
    unchangedPairs,
    excludedPairs,
  };
}

function pairedRunKey(run: PrEvalRunResult): string {
  return `${run.caseId}@${run.repetition}`;
}

function summarizeCaseOutcomes(
  sharedPairs: string[],
  comparablePairs: string[],
  baselineRuns: Map<string, PrEvalRunResult>,
  contextRuns: Map<string, PrEvalRunResult>,
): {
  improved: string[];
  regressed: string[];
  unchanged: string[];
  excluded: string[];
} {
  const caseIds = [...new Set(
    sharedPairs.map((key) => baselineRuns.get(key)!.caseId),
  )];
  const improved: string[] = [];
  const regressed: string[] = [];
  const unchanged: string[] = [];
  const excluded: string[] = [];
  for (const caseId of caseIds) {
    const pairs = comparablePairs.filter(
      (key) => baselineRuns.get(key)!.caseId === caseId,
    );
    if (!pairs.length) {
      excluded.push(caseId);
      continue;
    }
    const delta = pairs.reduce(
      (sum, key) =>
        sum +
        Number(comparisonOutcome(contextRuns.get(key)!)) -
        Number(comparisonOutcome(baselineRuns.get(key)!)),
      0,
    );
    if (delta > 0) improved.push(caseId);
    else if (delta < 0) regressed.push(caseId);
    else unchanged.push(caseId);
  }
  return { improved, regressed, unchanged, excluded };
}

function comparisonOutcome(run: PrEvalRunResult): boolean | undefined {
  if (run.status === "error") return undefined;
  if (
    run.failure &&
    ["setup", "baseline", "context", "cleanup"].includes(run.failure.stage)
  ) {
    return undefined;
  }
  return run.status === "passed";
}

function meanPairedMetricDelta(
  pairKeys: string[],
  baselineRuns: Map<string, PrEvalRunResult>,
  contextRuns: Map<string, PrEvalRunResult>,
  metric: (run: PrEvalRunResult) => number | undefined,
): number | undefined {
  return mean(
    pairKeys.flatMap((key) => {
      const baseline = metric(baselineRuns.get(key)!);
      const context = metric(contextRuns.get(key)!);
      return baseline === undefined || context === undefined
        ? []
        : [context - baseline];
    }),
  );
}

function mean(values: number[]): number | undefined {
  if (!values.length) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], percentileValue: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1),
  );
  return sorted[index];
}

function commandFailure(result: PrEvalCommandResult): string {
  if (result.spawnError) return `unable to start command: ${result.spawnError}`;
  if (result.timedOut) return `timed out after ${result.durationMs}ms`;
  const detail = result.stderr.trim() || result.stdout.trim();
  if (result.signal) {
    return `terminated by ${result.signal}${detail ? `: ${detail}` : ""}`;
  }
  return `exit ${String(result.exitCode)}${detail ? `: ${detail}` : ""}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function elapsedMs(started: number): number {
  return Number(Math.max(0, performance.now() - started).toFixed(3));
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function shortCommit(value: string): string {
  return value.slice(0, 12);
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatSignedPercent(value: number): string {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${(value * 100).toFixed(1)} pp`;
}

function formatDuration(value: number): string {
  return Math.abs(value) >= 1_000
    ? `${(value / 1_000).toFixed(2)} s`
    : `${value.toFixed(1)} ms`;
}

function formatSignedDuration(value: number): string {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${formatDuration(value)}`;
}

function formatOptionalNumber(value: number | undefined): string {
  return value === undefined ? "-" : value.toFixed(1);
}

function formatIdList(values: string[]): string {
  return values.length
    ? values.map((value) => `\`${escapeMarkdown(value)}\``).join(", ")
    : "none";
}
