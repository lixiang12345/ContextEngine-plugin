import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  formatPrEvalReportMarkdown,
  loadPrEvalSuite,
  parsePrEvalSuite,
  runPrEvalCommand,
  runPrEvalSuite,
  type PrEvalSuite,
} from "../src/eval/pr-harness.js";

describe("PR evaluation harness", () => {
  it("strictly validates and normalizes manifests", () => {
    const manifest = {
      schemaVersion: 1,
      name: "sample",
      repository: "repo",
      agent: { command: ["agent", "--prompt", "{prompt_file}"] },
      testCommand: ["npm", "test"],
      cases: [{ id: "task-1", prompt: "Fix the task" }],
    };
    const suite = parsePrEvalSuite(manifest, {
      baseDirectory: "/tmp/manifests",
    });

    assert.equal(suite.repository, "/tmp/manifests/repo");
    assert.equal(suite.isolation, "sanitized");
    assert.equal(suite.verifyBaseline, true);
    assert.equal(suite.repetitions, 1);
    assert.deepEqual(
      suite.variants.map((variant) => variant.id),
      ["baseline", "contextengine"],
    );
    assert.equal(suite.agent.timeoutMs, 15 * 60_000);

    assert.throws(
      () =>
        parsePrEvalSuite({
          name: "bad",
          repository: ".",
          agent: { command: "agent --unsafe" },
          testCommand: ["npm", "test"],
          cases: [{ id: "task", prompt: "Fix" }],
        }),
      /argv string array/,
    );
    assert.throws(
      () =>
        parsePrEvalSuite({
          name: "duplicate",
          repository: ".",
          agent: { command: ["agent"] },
          testCommand: ["npm", "test"],
          variants: [
            { id: "same", context: "none" },
            { id: "same", context: "packed" },
          ],
          cases: [{ id: "task", prompt: "Fix" }],
        }),
      /duplicate id same/,
    );

    assert.throws(
      () => parsePrEvalSuite({ ...manifest, unexpected: true }),
      /suite has unknown field\(s\): unexpected/,
    );
    assert.equal(
      parsePrEvalSuite({ ...manifest, repetitions: 3 }).repetitions,
      3,
    );
    assert.throws(
      () => parsePrEvalSuite({ ...manifest, repetitions: 0 }),
      /suite\.repetitions must be a positive integer/,
    );
    assert.throws(
      () => parsePrEvalSuite({ ...manifest, repetitions: 21 }),
      /suite\.repetitions must not exceed 20/,
    );
    assert.throws(
      () =>
        parsePrEvalSuite({
          ...manifest,
          agent: { ...manifest.agent, unexpected: true },
        }),
      /suite\.agent has unknown field\(s\): unexpected/,
    );
    assert.throws(
      () =>
        parsePrEvalSuite({
          ...manifest,
          variants: [
            { id: "baseline", context: "none", unexpected: true },
          ],
        }),
      /suite\.variants\[0\] has unknown field\(s\): unexpected/,
    );
    assert.throws(
      () =>
        parsePrEvalSuite({
          ...manifest,
          variants: [
            {
              id: "contextengine",
              context: { mode: "packed", unexpected: true },
            },
          ],
        }),
      /suite\.variants\[0\]\.context has unknown field\(s\): unexpected/,
    );
    assert.throws(
      () =>
        parsePrEvalSuite({
          ...manifest,
          cases: [
            { id: "task-1", prompt: "Fix the task", unexpected: true },
          ],
        }),
      /suite\.cases\[0\] has unknown field\(s\): unexpected/,
    );

    const corpus = loadPrEvalSuite(
      path.resolve("benchmarks/pr-history/contextengine-v1.json"),
    );
    assert.equal(corpus.repetitions, 3);
    assert.equal(corpus.cases.length, 3);
    assert.ok(corpus.cases.every((item) => item.goldRef?.length === 40));
    assert.ok(corpus.cases.every((item) => existsSync(item.testPatch!)));
  });

  it("executes argv literally and bounds captured output", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ce-pr-command-"));
    try {
      const marker = path.join(root, "must-not-exist");
      const literal = `; touch ${marker}; $(touch ${marker})`;
      const result = await runPrEvalCommand(
        [
          process.execPath,
          "-e",
          "process.stdout.write(process.argv[1] + 'x'.repeat(1024))",
          literal,
        ],
        { cwd: root, timeoutMs: 5_000, outputLimitBytes: 32 },
      );

      assert.equal(result.exitCode, 0);
      assert.equal(result.outputTruncated, true);
      assert.ok(result.stdout.startsWith("; touch"));
      assert.ok(result.stdoutBytes > result.stdout.length);
      assert.equal(existsSync(marker), false);

      const timed = await runPrEvalCommand(
        [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        { cwd: root, timeoutMs: 50, outputLimitBytes: 32 },
      );
      assert.equal(timed.timedOut, true);
      assert.notEqual(timed.signal, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects setup commands that modify benchmark files", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ce-pr-setup-dirty-"));
    const repository = path.join(root, "repository");
    mkdirSync(repository, { recursive: true });
    writeFileSync(path.join(repository, "tracked.txt"), "base\n");
    git(repository, ["init", "--quiet"]);
    git(repository, ["config", "user.name", "ContextEngine Test"]);
    git(repository, ["config", "user.email", "contextengine@example.invalid"]);
    git(repository, ["add", "."]);
    git(repository, ["commit", "--quiet", "-m", "base"]);
    const suite = parsePrEvalSuite({
      schemaVersion: 1,
      name: "dirty-setup",
      repository,
      agent: { command: [process.execPath, "-e", "process.exit(0)"] },
      setupCommand: [
        process.execPath,
        "-e",
        [
          'const fs = require("node:fs");',
          'fs.writeFileSync("tracked.txt", "changed\\n");',
          'fs.writeFileSync("generated.txt", "generated\\n");',
        ].join(""),
      ],
      testCommand: [process.execPath, "-e", "process.exit(1)"],
      variants: [{ id: "baseline", context: "none" }],
      cases: [{ id: "dirty", prompt: "Do not run the agent" }],
    });

    try {
      const report = await runPrEvalSuite(suite, { tempRoot: root });
      assert.equal(report.summary.totalRuns, 1);
      assert.equal(report.summary.errors, 1);
      const [run] = report.runs;
      assert.equal(run.status, "error");
      assert.equal(run.failure?.stage, "setup");
      assert.match(run.failure?.message ?? "", /setup modified benchmark files/);
      assert.deepEqual(run.patch?.changedFiles, [
        "generated.txt",
        "tracked.txt",
      ]);
      assert.equal(run.agent, undefined);
      assert.equal(readFileSync(path.join(repository, "tracked.txt"), "utf8"), "base\n");
      assert.equal(existsSync(path.join(repository, "generated.txt")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("terminates background agent processes before hidden tests run", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ce-pr-background-"));
    const repository = createRepository(root, {
      "src/value.txt": "1\n",
    });
    const workerScript = path.join(root, "background-worker.mjs");
    writeFileSync(
      workerScript,
      [
        'import { existsSync, writeFileSync } from "node:fs";',
        'import path from "node:path";',
        'const workspace = process.argv[2];',
        'const timer = setInterval(() => {',
        '  if (!existsSync(path.join(workspace, "oracle.mjs"))) return;',
        '  writeFileSync(path.join(workspace, "src/value.txt"), "2\\n");',
        '  clearInterval(timer);',
        '}, 5);',
      ].join("\n"),
    );
    const agentScript = path.join(root, "background-agent.mjs");
    writeFileSync(
      agentScript,
      [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        'import path from "node:path";',
        `const workerScript = ${JSON.stringify(workerScript)};`,
        'const workspace = process.env.CONTEXTENGINE_PR_EVAL_WORKSPACE;',
        'writeFileSync(path.join(workspace, "decoy.txt"), "decoy\\n");',
        'spawn(process.execPath, [workerScript, workspace], { stdio: "ignore" }).unref();',
      ].join("\n"),
    );
    const testPatch = path.join(root, "hidden-tests.patch");
    writeFileSync(
      testPatch,
      [
        "diff --git a/oracle.mjs b/oracle.mjs",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/oracle.mjs",
        "@@ -0,0 +1,4 @@",
        '+import { readFileSync } from "node:fs";',
        "+await new Promise((resolve) => setTimeout(resolve, 200));",
        '+const value = readFileSync(new URL("./src/value.txt", import.meta.url), "utf8").trim();',
        '+if (value !== "2") process.exit(1);',
        "",
      ].join("\n"),
    );
    const suite = parsePrEvalSuite({
      schemaVersion: 1,
      name: "background-process",
      repository,
      agent: { command: [process.execPath, agentScript], timeoutMs: 5_000 },
      testCommand: [process.execPath, "oracle.mjs"],
      variants: [{ id: "baseline", context: "none" }],
      cases: [
        {
          id: "background-write",
          prompt: "Change the stored value from 1 to 2.",
          testPatch,
        },
      ],
    });

    try {
      const report = await runPrEvalSuite(suite, {
        tempRoot: root,
        keepWorktrees: true,
      });
      const [run] = report.runs;
      assert.equal(run.status, "failed");
      assert.equal(run.test?.exitCode, 1);
      assert.deepEqual(run.patch?.changedFiles, ["decoy.txt"]);
      assert.doesNotMatch(run.patch?.diff ?? "", /oracle\.mjs/);
      assert.ok(run.workspace);
      assert.equal(existsSync(path.join(run.workspace!, ".git", "FETCH_HEAD")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("isolates baseline hidden-test side effects from the agent workspace", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ce-pr-baseline-isolation-"));
    const repository = createRepository(root, {
      ".gitignore": ".cache/\n",
      "src/value.txt": "1\n",
    });
    const agentScript = path.join(root, "marker-observer-agent.mjs");
    writeFileSync(
      agentScript,
      [
        'import { existsSync, writeFileSync } from "node:fs";',
        'import path from "node:path";',
        'const workspace = process.env.CONTEXTENGINE_PR_EVAL_WORKSPACE;',
        'const marker = path.join(workspace, ".cache", "baseline-marker");',
        "writeFileSync(",
        '  path.join(workspace, "agent-observation.txt"),',
        '  existsSync(marker) ? "marker-present\\n" : "no-marker\\n",',
        ");",
        'writeFileSync(path.join(workspace, "src/value.txt"), "2\\n");',
      ].join("\n"),
    );
    const testPatch = path.join(root, "hidden-tests.patch");
    writeFileSync(
      testPatch,
      [
        "diff --git a/oracle.mjs b/oracle.mjs",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/oracle.mjs",
        "@@ -0,0 +1,6 @@",
        '+import { mkdirSync, readFileSync, writeFileSync } from "node:fs";',
        '+mkdirSync(new URL("./.cache/", import.meta.url), { recursive: true });',
        '+writeFileSync(new URL("./.cache/baseline-marker", import.meta.url), "created\\n");',
        '+process.stdout.write("created-cache-marker\\n");',
        '+const value = readFileSync(new URL("./src/value.txt", import.meta.url), "utf8").trim();',
        '+if (value !== "2") process.exit(1);',
        "",
      ].join("\n"),
    );
    const suite = parsePrEvalSuite({
      schemaVersion: 1,
      name: "baseline-isolation",
      repository,
      agent: { command: [process.execPath, agentScript] },
      testCommand: [process.execPath, "oracle.mjs"],
      variants: [{ id: "baseline", context: "none" }],
      cases: [
        {
          id: "ignored-side-effect",
          prompt: "Change the value to 2.",
          testPatch,
        },
      ],
    });

    try {
      const report = await runPrEvalSuite(suite, {
        tempRoot: root,
        keepWorktrees: true,
      });
      const [run] = report.runs;
      assert.equal(run.baselineTest?.exitCode, 1);
      assert.match(run.baselineTest?.stdout ?? "", /created-cache-marker/);
      assert.equal(run.status, "passed");
      assert.ok(run.workspace);
      assert.equal(
        readFileSync(path.join(run.workspace!, "agent-observation.txt"), "utf8"),
        "no-marker\n",
      );
      assert.deepEqual(run.patch?.changedFiles, [
        "agent-observation.txt",
        "src/value.txt",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it(
    "surfaces shared-history cleanup failures after an earlier run error",
    { skip: process.platform === "win32" },
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "ce-pr-cleanup-error-"));
      const repository = createRepository(root, { "README.md": "fixture\n" });
      const gitDirectory = path.join(repository, ".git");
      const hiddenGitDirectory = path.join(repository, ".git-hidden");
      const agentScript = path.join(root, "break-cleanup-agent.mjs");
      writeFileSync(
        agentScript,
        [
          'import { renameSync } from "node:fs";',
          `renameSync(${JSON.stringify(gitDirectory)}, ${JSON.stringify(hiddenGitDirectory)});`,
          "process.exit(1);",
        ].join("\n"),
      );
      const suite = parsePrEvalSuite({
        schemaVersion: 1,
        name: "cleanup-error",
        repository,
        isolation: "shared-history",
        agent: { command: [process.execPath, agentScript] },
        testCommand: [process.execPath, "-e", "process.exit(0)"],
        verifyBaseline: false,
        requireChanges: false,
        variants: [{ id: "baseline", context: "none" }],
        cases: [{ id: "cleanup", prompt: "Inspect the fixture." }],
      });

      try {
        const report = await runPrEvalSuite(suite, { tempRoot: root });
        const [run] = report.runs;
        assert.equal(run.status, "error");
        assert.equal(run.failure?.stage, "cleanup");
        assert.match(
          run.failure?.message ?? "",
          /unable to remove shared-history worktree/,
        );
        assert.match(run.failure?.message ?? "", /run status before cleanup: error/);
        assert.deepEqual(report.summary.comparison, undefined);
      } finally {
        if (existsSync(hiddenGitDirectory) && !existsSync(gitDirectory)) {
          renameSync(hiddenGitDirectory, gitDirectory);
          git(repository, ["worktree", "prune"]);
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("classifies missing agent and test executables as infrastructure errors", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ce-pr-spawn-error-"));
    const repository = createRepository(root, {
      "src/value.txt": "1\n",
      "oracle.mjs": [
        'import { readFileSync } from "node:fs";',
        'const value = readFileSync(new URL("./src/value.txt", import.meta.url), "utf8").trim();',
        'if (value !== "2") process.exit(1);',
        "",
      ].join("\n"),
    });
    const agentScript = path.join(root, "valid-agent.mjs");
    writeFileSync(
      agentScript,
      [
        'import { writeFileSync } from "node:fs";',
        'import path from "node:path";',
        'writeFileSync(path.join(process.env.CONTEXTENGINE_PR_EVAL_WORKSPACE, "src/value.txt"), "2\\n");',
      ].join("\n"),
    );

    try {
      const paired = parsePrEvalSuite({
        schemaVersion: 1,
        name: "missing-agent",
        repository,
        agent: { command: [process.execPath, agentScript] },
        testCommand: [process.execPath, "oracle.mjs"],
        variants: [
          {
            id: "baseline",
            context: "none",
            command: [path.join(root, "missing-agent")],
          },
          {
            id: "contextengine",
            context: "packed",
            command: [process.execPath, agentScript],
          },
        ],
        cases: [{ id: "spawn", prompt: "Change the value to 2." }],
      });
      const pairedReport = await runPrEvalSuite(paired, {
        tempRoot: root,
        contextProvider: async () => ({
          text: "Change src/value.txt.",
          estimatedTokens: 4,
          hitPaths: ["src/value.txt"],
          durationMs: 1,
          truncated: false,
        }),
      });
      const failedAgent = pairedReport.runs.find(
        (run) => run.variantId === "baseline",
      )!;
      assert.equal(failedAgent.status, "error");
      assert.equal(failedAgent.failure?.stage, "agent");
      assert.match(failedAgent.agent?.spawnError ?? "", /ENOENT/);
      assert.equal(pairedReport.summary.errors, 1);
      assert.equal(pairedReport.summary.failed, 0);
      assert.deepEqual(pairedReport.summary.comparison?.improvedCases, []);
      assert.deepEqual(pairedReport.summary.comparison?.excludedCases, ["spawn"]);

      const missingTest = parsePrEvalSuite({
        schemaVersion: 1,
        name: "missing-test",
        repository,
        agent: { command: [process.execPath, agentScript] },
        testCommand: [path.join(root, "missing-test")],
        verifyBaseline: false,
        variants: [{ id: "baseline", context: "none" }],
        cases: [{ id: "spawn", prompt: "Change the value to 2." }],
      });
      const testReport = await runPrEvalSuite(missingTest, { tempRoot: root });
      const [failedTest] = testReport.runs;
      assert.equal(failedTest.status, "error");
      assert.equal(failedTest.failure?.stage, "test");
      assert.match(failedTest.test?.spawnError ?? "", /ENOENT/);
      assert.equal(testReport.summary.errors, 1);
      assert.equal(testReport.summary.failed, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("captures untracked files in patch content and statistics", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ce-pr-untracked-"));
    const repository = createRepository(root, {
      "oracle.mjs": [
        'import { existsSync, readFileSync } from "node:fs";',
        'const target = new URL("./new.txt", import.meta.url);',
        'if (!existsSync(target) || !readFileSync(target, "utf8").startsWith("new")) process.exit(1);',
        "",
      ].join("\n"),
    });
    const agentScript = path.join(root, "new-file-agent.mjs");
    writeFileSync(
      agentScript,
      [
        'import { writeFileSync } from "node:fs";',
        'import path from "node:path";',
        'writeFileSync(path.join(process.env.CONTEXTENGINE_PR_EVAL_WORKSPACE, "new.txt"), "new line  \\n");',
      ].join("\n"),
    );
    const suite = parsePrEvalSuite({
      schemaVersion: 1,
      name: "untracked-patch",
      repository,
      agent: { command: [process.execPath, agentScript] },
      testCommand: [process.execPath, "oracle.mjs"],
      variants: [{ id: "baseline", context: "none" }],
      cases: [{ id: "new-file", prompt: "Create new.txt." }],
    });

    try {
      const report = await runPrEvalSuite(suite, { tempRoot: root });
      const [run] = report.runs;
      assert.equal(run.status, "passed");
      assert.deepEqual(run.patch?.changedFiles, ["new.txt"]);
      assert.equal(run.patch?.insertions, 1);
      assert.equal(run.patch?.deletions, 0);
      assert.ok((run.patch?.patchBytes ?? 0) > 0);
      assert.match(run.patch?.diff ?? "", /new file mode/);
      assert.match(run.patch?.diff ?? "", /new line/);
      assert.equal(run.patch?.diffTruncated, false);
      assert.match(run.patch?.diffSha256 ?? "", /^[a-f0-9]{64}$/);
      assert.equal(run.patch?.diffCheckPassed, false);
      assert.match(run.patch?.diffCheckOutput ?? "", /trailing whitespace/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports exact raw, agent-prompt, and context SHA-256 values", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ce-pr-hashes-"));
    const repository = createRepository(root, { "README.md": "fixture\n" });
    const taskPrompt = "Fix the value.";
    const packedContext = "  Evidence line.\n";
    const suite = parsePrEvalSuite({
      schemaVersion: 1,
      name: "prompt-hashes",
      repository,
      agent: { command: [process.execPath, "-e", "process.exit(0)"] },
      testCommand: [process.execPath, "-e", "process.exit(0)"],
      verifyBaseline: false,
      variants: [
        { id: "baseline", context: "none" },
        { id: "contextengine", context: "packed" },
      ],
      cases: [{ id: "hashes", prompt: taskPrompt }],
    });

    try {
      const report = await runPrEvalSuite(suite, {
        tempRoot: root,
        contextProvider: async () => ({
          text: packedContext,
          estimatedTokens: 3,
          hitPaths: ["README.md"],
          durationMs: 1,
          truncated: false,
        }),
      });
      const baseline = report.runs.find((run) => run.variantId === "baseline")!;
      const packed = report.runs.find(
        (run) => run.variantId === "contextengine",
      )!;
      const rawPromptSha256 = sha256(taskPrompt);

      assert.equal(baseline.promptSha256, rawPromptSha256);
      assert.equal(baseline.agentPromptSha256, sha256(`${taskPrompt}\n`));
      assert.equal(baseline.contextSha256, sha256(""));
      assert.equal(packed.promptSha256, rawPromptSha256);
      assert.equal(
        packed.agentPromptSha256,
        sha256(
          [
            taskPrompt,
            "",
            "# ContextEngine evidence",
            "",
            packedContext.trim(),
            "",
          ].join("\n"),
        ),
      );
      assert.equal(packed.contextSha256, sha256(packedContext));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("compares every packed variant against each no-context variant", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ce-pr-comparisons-"));
    const repository = createRepository(root, { "README.md": "fixture\n" });
    const suite = parsePrEvalSuite({
      schemaVersion: 1,
      name: "multiple-comparisons",
      repository,
      agent: { command: [process.execPath, "-e", "process.exit(0)"] },
      testCommand: [process.execPath, "-e", "process.exit(0)"],
      verifyBaseline: false,
      variants: [
        { id: "baseline", context: "none" },
        { id: "baseline-b", context: "none" },
        { id: "packed-a", context: "packed" },
        { id: "packed-b", context: "packed" },
      ],
      cases: [{ id: "compare", prompt: "Inspect the fixture." }],
    });

    try {
      const report = await runPrEvalSuite(suite, {
        tempRoot: root,
        contextProvider: async () => ({
          text: "README.md contains the fixture.",
          estimatedTokens: 5,
          hitPaths: ["README.md"],
          durationMs: 1,
          truncated: false,
        }),
      });

      assert.equal(report.summary.comparisons?.length, 4);
      assert.deepEqual(
        report.summary.comparisons?.map((comparison) => [
          comparison.baselineVariantId,
          comparison.contextVariantId,
        ]),
        [
          ["baseline", "packed-a"],
          ["baseline", "packed-b"],
          ["baseline-b", "packed-a"],
          ["baseline-b", "packed-b"],
        ],
      );
      assert.deepEqual(
        report.summary.comparison,
        report.summary.comparisons?.[0],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs paired agents in sanitized repos and keeps hidden tests out of the patch", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ce-pr-suite-"));
    const repository = path.join(root, "repository");
    mkdirSync(path.join(repository, "src"), { recursive: true });
    writeFileSync(path.join(repository, "src", "value.txt"), "1\n");
    git(repository, ["init", "--quiet"]);
    git(repository, ["config", "user.name", "ContextEngine Test"]);
    git(repository, ["config", "user.email", "contextengine@example.invalid"]);
    git(repository, ["add", "."]);
    git(repository, ["commit", "--quiet", "-m", "base"]);
    const baseCommit = git(repository, ["rev-parse", "HEAD"]).trim();

    const agentScript = path.join(root, "fake-agent.mjs");
    writeFileSync(
      agentScript,
      [
        'import { readFileSync, writeFileSync } from "node:fs";',
        'import path from "node:path";',
        'const prompt = readFileSync(process.env.CONTEXTENGINE_PR_EVAL_PROMPT_FILE, "utf8");',
        'const candidate = prompt.includes("# ContextEngine evidence");',
        'if (candidate) writeFileSync(path.join(process.env.CONTEXTENGINE_PR_EVAL_WORKSPACE, "src/value.txt"), "2\\n");',
        'writeFileSync(process.env.CONTEXTENGINE_PR_EVAL_METRICS_FILE, JSON.stringify({',
        '  model: "fake-agent", inputTokens: candidate ? 70 : 100, outputTokens: 20,',
        '  toolCalls: candidate ? 2 : 4, costUsd: candidate ? 0.01 : 0.02',
        '}));',
      ].join("\n"),
    );
    const testPatch = path.join(root, "hidden-tests.patch");
    writeFileSync(
      testPatch,
      [
        "diff --git a/oracle.mjs b/oracle.mjs",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/oracle.mjs",
        "@@ -0,0 +1,3 @@",
        '+import { readFileSync } from "node:fs";',
        '+const value = readFileSync(new URL("./src/value.txt", import.meta.url), "utf8").trim();',
        '+if (value !== "2") process.exit(1);',
        "",
      ].join("\n"),
    );

    const suite: PrEvalSuite = parsePrEvalSuite({
      schemaVersion: 1,
      name: "paired-smoke",
      repository,
      isolation: "sanitized",
      agent: { command: [process.execPath, agentScript], timeoutMs: 5_000 },
      testCommand: [process.execPath, "oracle.mjs"],
      verifyBaseline: true,
      requireChanges: true,
      repetitions: 3,
      variants: [
        { id: "baseline", context: "none" },
        {
          id: "contextengine",
          context: { mode: "packed", topK: 4, maxTokens: 100 },
        },
      ],
      cases: [
        {
          id: "fix-value",
          baseRef: baseCommit,
          goldRef: baseCommit,
          prompt: "Change the stored value from 1 to 2.",
          testPatch,
          expectedChangedPaths: ["src/value.txt"],
        },
      ],
    });

    try {
      const progress: string[] = [];
      const contextRepetitions: number[] = [];
      const report = await runPrEvalSuite(suite, {
        tempRoot: root,
        keepWorktrees: true,
        onProgress: (event) => {
          progress.push(
            `${event.phase}:${event.repetition}:${event.variantId}:${event.completedRuns}/${event.totalRuns}`,
          );
        },
        contextProvider: async (input) => {
          contextRepetitions.push(input.repetition);
          assert.equal(input.runId, `fix-value@${input.repetition}:contextengine`);
          return {
            text: "The value is stored in src/value.txt.",
            estimatedTokens: 9,
            hitPaths: ["src/value.txt"],
            durationMs: 1,
            truncated: false,
          };
        },
      });

      assert.equal(report.suite.repetitions, 3);
      assert.equal(report.summary.totalRuns, 6);
      assert.equal(report.summary.passed, 3);
      assert.equal(report.summary.failed, 3);
      assert.deepEqual(report.summary.comparison?.improvedCases, ["fix-value"]);
      assert.deepEqual(report.summary.comparison?.regressedCases, []);
      assert.deepEqual(report.summary.comparison?.excludedCases, []);
      assert.equal(report.summary.comparison?.comparedPairs, 3);
      assert.deepEqual(report.summary.comparison?.improvedPairs, [
        "fix-value@1",
        "fix-value@2",
        "fix-value@3",
      ]);
      assert.deepEqual(report.summary.comparison?.unchangedPairs, []);
      assert.equal(report.summary.comparison?.meanTotalTokensDelta, -30);
      assert.equal(report.summary.comparison?.meanToolCallsDelta, -2);
      assert.deepEqual(contextRepetitions, [1, 2, 3]);
      assert.deepEqual(
        report.runs.map((run) => [run.repetition, run.variantId]),
        [
          [1, "baseline"],
          [1, "contextengine"],
          [2, "baseline"],
          [2, "contextengine"],
          [3, "baseline"],
          [3, "contextengine"],
        ],
      );
      assert.equal(new Set(report.runs.map((run) => run.runId)).size, 6);
      assert.deepEqual(progress.slice(0, 4), [
        "start:1:baseline:0/6",
        "complete:1:baseline:1/6",
        "start:1:contextengine:1/6",
        "complete:1:contextengine:2/6",
      ]);
      for (const run of report.runs) {
        assert.ok(run.workspace);
        const metricsFile = path.join(
          path.dirname(run.workspace!),
          "run",
          `agent-metrics-r${run.repetition}.json`,
        );
        assert.equal(existsSync(metricsFile), true);
      }
      const baseline = report.runs.find((run) => run.variantId === "baseline")!;
      const candidate = report.runs.find(
        (run) => run.variantId === "contextengine",
      )!;
      assert.equal(baseline.status, "failed");
      assert.equal(candidate.status, "passed");
      assert.deepEqual(candidate.patch?.changedFiles, ["src/value.txt"]);
      assert.equal(candidate.patch?.changedFiles.includes("oracle.mjs"), false);
      assert.doesNotMatch(candidate.patch?.diff ?? "", /oracle\.mjs/);
      assert.equal(candidate.testPatchApplied, true);
      assert.equal(candidate.expectedPathCoverage, 1);
      assert.equal(candidate.usage?.totalTokens, 90);
      assert.equal(candidate.usage?.toolCalls, 2);
      assert.equal(candidate.context?.hitPaths[0], "src/value.txt");
      assert.equal(candidate.goldRef, baseCommit);
      assert.equal(candidate.goldCommit, baseCommit);
      assert.equal(readFileSync(path.join(repository, "src", "value.txt"), "utf8"), "1\n");

      const markdown = formatPrEvalReportMarkdown(report);
      assert.match(markdown, /PR evaluation: paired-smoke/);
      assert.match(markdown, /Improved cases: `fix-value`/);
      assert.match(markdown, /Repetitions per case\/variant: 3/);
      assert.match(markdown, /Improved pairs: `fix-value@1`/);
      assert.match(markdown, /Isolation: `sanitized`/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function createRepository(
  root: string,
  files: Record<string, string>,
): string {
  const repository = path.join(root, "repository");
  mkdirSync(repository, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(repository, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  git(repository, ["init", "--quiet"]);
  git(repository, ["config", "user.name", "ContextEngine Test"]);
  git(repository, ["config", "user.email", "contextengine@example.invalid"]);
  git(repository, ["add", "."]);
  git(repository, ["commit", "--quiet", "-m", "base"]);
  return repository;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
