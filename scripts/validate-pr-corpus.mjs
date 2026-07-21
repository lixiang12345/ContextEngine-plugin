#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.resolve(
  process.argv[2] ??
    path.join(projectRoot, "benchmarks/pr-history/contextengine-v1.json"),
);
const manifestDirectory = path.dirname(manifestPath);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const repository = path.resolve(manifestDirectory, manifest.repository);
const sharedNodeModules = path.join(projectRoot, "node_modules");

if (!existsSync(path.join(repository, ".git"))) {
  throw new Error(`Corpus repository must be a full Git checkout: ${repository}`);
}
if (!existsSync(sharedNodeModules)) {
  throw new Error("node_modules is missing; run npm ci before corpus validation");
}
if (!Array.isArray(manifest.cases) || manifest.cases.length === 0) {
  throw new Error("Corpus manifest must contain at least one case");
}

let checks = 0;
for (const evalCase of manifest.cases) {
  const testPatch = path.resolve(manifestDirectory, evalCase.testPatch);
  if (!existsSync(testPatch)) {
    throw new Error(`${evalCase.id}: test patch does not exist: ${testPatch}`);
  }
  validateCommand(evalCase.testCommand, `${evalCase.id}.testCommand`);
  validateAdditiveOracle(evalCase, testPatch);
  validateExpectedImplementationPaths(evalCase);
  await validateRevision(evalCase, "base", evalCase.baseRef, false, testPatch);
  await validateRevision(evalCase, "gold", evalCase.goldRef, true, testPatch);
  checks += 2;
}

console.log(`Validated ${checks} base/gold corpus oracle checks.`);

function validateAdditiveOracle(evalCase, testPatch) {
  const summary = runChecked(
    ["git", "apply", "--summary", testPatch],
    repository,
    `${evalCase.id}: inspect oracle patch`,
  );
  const changes = summary.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!changes.length || changes.some((line) => !line.startsWith("create mode "))) {
    throw new Error(
      `${evalCase.id}: oracle patch must only create uniquely named test files`,
    );
  }
}

function validateExpectedImplementationPaths(evalCase) {
  if (!Array.isArray(evalCase.expectedChangedPaths)) return;
  const changed = runChecked(
    ["git", "diff", "--name-only", `${evalCase.baseRef}..${evalCase.goldRef}`],
    repository,
    `${evalCase.id}: inspect base-to-gold paths`,
  ).stdout.split("\n").filter(Boolean);
  for (const expectedPath of evalCase.expectedChangedPaths) {
    if (!changed.includes(expectedPath)) {
      throw new Error(
        `${evalCase.id}: expected implementation path is absent from base-to-gold diff: ${expectedPath}`,
      );
    }
  }
}

async function validateRevision(evalCase, label, revision, shouldPass, testPatch) {
  if (typeof revision !== "string" || !revision) {
    throw new Error(`${evalCase.id}: ${label} revision is missing`);
  }
  runChecked(
    ["git", "rev-parse", "--verify", `${revision}^{commit}`],
    repository,
    `${evalCase.id}: resolve ${label} revision`,
  );

  const tempDirectory = mkdtempSync(
    path.join(tmpdir(), `contextengine-corpus-${safeLabel(evalCase.id)}-${label}-`),
  );
  const workspace = path.join(tempDirectory, "workspace");
  let worktreeCreated = false;
  try {
    runChecked(
      ["git", "worktree", "add", "--quiet", "--detach", workspace, revision],
      repository,
      `${evalCase.id}: create ${label} worktree`,
    );
    worktreeCreated = true;
    symlinkSync(sharedNodeModules, path.join(workspace, "node_modules"), "junction");
    runChecked(
      ["git", "apply", "--whitespace=nowarn", testPatch],
      workspace,
      `${evalCase.id}: apply oracle to ${label}`,
    );

    const test = run(evalCase.testCommand, workspace);
    if (test.error) {
      throw new Error(
        `${evalCase.id}: ${label} oracle could not start: ${test.error.message}`,
      );
    }
    const passed = test.status === 0;
    if (passed !== shouldPass) {
      const expectation = shouldPass ? "pass" : "fail";
      throw new Error(
        [
          `${evalCase.id}: ${label} oracle must ${expectation}, got exit ${String(test.status)}`,
          test.stdout,
          test.stderr,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
    console.log(
      `${evalCase.id}: ${label} ${revision.slice(0, 12)} ${passed ? "passed" : "failed as expected"}`,
    );
  } finally {
    rmSync(path.join(workspace, "node_modules"), {
      recursive: true,
      force: true,
    });
    if (worktreeCreated) {
      const removed = run(
        ["git", "worktree", "remove", "--force", workspace],
        repository,
      );
      if (removed.status !== 0) {
        run(["git", "worktree", "prune"], repository);
      }
    }
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

function runChecked(command, cwd, operation) {
  const result = run(command, cwd);
  if (result.error || result.status !== 0) {
    throw new Error(
      [
        `${operation} failed`,
        result.error?.message,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result;
}

function run(command, cwd) {
  return spawnSync(command[0], command.slice(1), {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 2 * 60_000,
    windowsHide: true,
  });
}

function validateCommand(command, label) {
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some((value) => typeof value !== "string" || value.length === 0)
  ) {
    throw new Error(`${label} must be a non-empty argv array`);
  }
}

function safeLabel(value) {
  return String(value).replaceAll(/[^A-Za-z0-9._-]/g, "-");
}
