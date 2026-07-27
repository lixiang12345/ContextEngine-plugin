import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  parsePrEvalSuite,
  runPrEvalSuite,
} from "../src/eval/pr-harness.js";

const dockerImage = process.env.CONTEXTENGINE_PR_EVAL_DOCKER_TEST_IMAGE;

describe("PR evaluation Docker sandbox", () => {
  it(
    "keeps the host oracle outside the agent container while returning patch and metrics",
    { skip: dockerImage ? false : "set CONTEXTENGINE_PR_EVAL_DOCKER_TEST_IMAGE" },
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "ce-pr-docker-"));
      const repository = path.join(root, "repository");
      mkdirSync(path.join(repository, "src"), { recursive: true });
      writeFileSync(path.join(repository, "src", "value.txt"), "1\n");
      git(repository, ["init", "--quiet"]);
      git(repository, ["config", "user.name", "ContextEngine Test"]);
      git(repository, ["config", "user.email", "contextengine@example.invalid"]);
      git(repository, ["add", "."]);
      git(repository, ["commit", "--quiet", "-m", "base"]);

      const testPatch = path.join(root, "host-hidden-tests.patch");
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
      const agentSource = [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        "let oracleVisible = false;",
        "try { fs.readFileSync(process.env.HOST_ORACLE_PATH); oracleVisible = true; } catch {}",
        'fs.writeFileSync(path.join(process.env.CONTEXTENGINE_PR_EVAL_WORKSPACE, "oracle-observation.txt"), oracleVisible ? "visible\\n" : "hidden\\n");',
        'fs.writeFileSync(path.join(process.env.CONTEXTENGINE_PR_EVAL_WORKSPACE, "src/value.txt"), "2\\n");',
        'fs.writeFileSync(process.env.CONTEXTENGINE_PR_EVAL_METRICS_FILE, JSON.stringify({ model: "docker-smoke", totalTokens: 3, toolCalls: 1 }));',
      ].join("\n");
      const suite = parsePrEvalSuite({
        schemaVersion: 1,
        name: "docker-hidden-oracle",
        repository,
        agent: {
          command: ["node", "-e", agentSource],
          env: { HOST_ORACLE_PATH: testPatch },
          sandbox: { type: "docker", image: dockerImage },
        },
        testCommand: [process.execPath, "oracle.mjs"],
        variants: [{ id: "baseline", context: "none" }],
        cases: [
          {
            id: "hidden-oracle",
            prompt: "Change src/value.txt from 1 to 2.",
            testPatch,
            expectedChangedPaths: ["src/value.txt"],
          },
        ],
      });

      try {
        const report = await runPrEvalSuite(suite, {
          tempRoot: root,
          keepWorktrees: true,
        });
        const [run] = report.runs;
        assert.equal(run.status, "passed");
        assert.equal(run.testPatchApplied, true);
        assert.equal(run.usage?.model, "docker-smoke");
        assert.equal(run.usage?.totalTokens, 3);
        assert.equal(run.expectedPathCoverage, 1);
        assert.ok(run.workspace);
        assert.equal(
          readFileSync(
            path.join(run.workspace!, "oracle-observation.txt"),
            "utf8",
          ),
          "hidden\n",
        );
        assert.equal(
          existsSync(path.join(path.dirname(run.workspace!), ".agent-container.env")),
          false,
        );
        assert.equal(report.suite.agentExecution.type, "docker");
        assert.equal(report.suite.agentExecution.network, "none");
        assert.equal(report.suite.agentExecution.readOnlyRoot, true);
        assert.ok(run.agent?.command.includes("--read-only"));
        assert.ok(run.agent?.command.includes("no-new-privileges"));
        assert.equal(run.agent?.command.includes(testPatch), false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it(
    "removes a timed-out container before applying the hidden oracle",
    { skip: dockerImage ? false : "set CONTEXTENGINE_PR_EVAL_DOCKER_TEST_IMAGE" },
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "ce-pr-docker-timeout-"));
      const repository = path.join(root, "repository");
      mkdirSync(path.join(repository, "src"), { recursive: true });
      writeFileSync(path.join(repository, "src", "value.txt"), "1\n");
      git(repository, ["init", "--quiet"]);
      git(repository, ["config", "user.name", "ContextEngine Test"]);
      git(repository, ["config", "user.email", "contextengine@example.invalid"]);
      git(repository, ["add", "."]);
      git(repository, ["commit", "--quiet", "-m", "base"]);

      const testPatch = path.join(root, "host-hidden-timeout-tests.patch");
      writeFileSync(
        testPatch,
        [
          "diff --git a/oracle.mjs b/oracle.mjs",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/oracle.mjs",
          "@@ -0,0 +1,4 @@",
          '+import { readFileSync } from "node:fs";',
          '+await new Promise((resolve) => setTimeout(resolve, 250));',
          '+const value = readFileSync(new URL("./src/value.txt", import.meta.url), "utf8").trim();',
          '+if (value !== "2") process.exit(1);',
          "",
        ].join("\n"),
      );
      const watcherSource = [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        "setInterval(() => {",
        '  if (!fs.existsSync(path.join(process.env.CONTEXTENGINE_PR_EVAL_WORKSPACE, "oracle.mjs"))) return;',
        '  fs.writeFileSync(path.join(process.env.CONTEXTENGINE_PR_EVAL_WORKSPACE, "src/value.txt"), "2\\n");',
        "}, 5);",
      ].join("\n");
      const suite = parsePrEvalSuite({
        schemaVersion: 1,
        name: "docker-timeout-cleanup",
        repository,
        agent: {
          command: ["node", "-e", watcherSource],
          timeoutMs: 100,
          sandbox: { type: "docker", image: dockerImage },
        },
        testCommand: [process.execPath, "oracle.mjs"],
        variants: [{ id: "baseline", context: "none" }],
        cases: [
          {
            id: "timeout-cleanup",
            prompt: "Change src/value.txt from 1 to 2.",
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
        assert.equal(run.status, "timeout");
        assert.equal(run.agent?.timedOut, true);
        assert.equal(run.test?.exitCode, 1);
        assert.equal(run.patch?.changedFiles.includes("oracle.mjs"), false);
        assert.ok(run.workspace);
        assert.equal(
          readFileSync(path.join(run.workspace!, "src/value.txt"), "utf8"),
          "1\n",
        );
        const nameIndex = run.agent!.command.indexOf("--name");
        const containerName = run.agent!.command[nameIndex + 1];
        assert.ok(containerName);
        assert.equal(
          execFileSync(
            "docker",
            ["ps", "-a", "--filter", `name=^/${containerName}$`, "--quiet"],
            { encoding: "utf8" },
          ).trim(),
          "",
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
