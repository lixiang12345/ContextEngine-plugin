import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  loadWorkspaceRules,
  formatRulesSection,
} from "../src/rules/rules-loader.js";

describe("workspace rules loader", () => {
  it("returns no rules for a workspace without convention files", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ce-rules-empty-"));
    try {
      assert.deepEqual(loadWorkspaceRules(root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("loads root convention files as always-applied, highest precedence", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ce-rules-root-"));
    try {
      writeFileSync(path.join(root, "AGENTS.md"), "Use tabs, not spaces.\n");
      writeFileSync(path.join(root, "CLAUDE.md"), "Prefer small commits.\n");
      const rules = loadWorkspaceRules(root);
      assert.equal(rules.length, 2);
      assert.ok(rules.every((rule) => rule.scope === "always"));
      // Root files sort before any directory rules and keep stable order.
      assert.deepEqual(
        rules.map((rule) => rule.path).sort(),
        ["AGENTS.md", "CLAUDE.md"],
      );
      assert.match(rules[0].content, /tabs|commits/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("scopes .augment/rules entries and honors alwaysApply frontmatter", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ce-rules-dir-"));
    try {
      const rulesDir = path.join(root, ".augment", "rules");
      mkdirSync(rulesDir, { recursive: true });
      writeFileSync(
        path.join(rulesDir, "logging.md"),
        "---\nalwaysApply: false\n---\nAlways log with the structured logger.\n",
      );
      writeFileSync(
        path.join(rulesDir, "security.md"),
        "---\nalwaysApply: true\n---\nNever log secrets.\n",
      );
      const rules = loadWorkspaceRules(root);
      const byPath = Object.fromEntries(rules.map((r) => [r.path, r]));
      assert.equal(byPath[".augment/rules/security.md"].scope, "always");
      assert.equal(
        byPath[".augment/rules/logging.md"].scope,
        "agent-requested",
      );
      // Frontmatter is stripped from the body.
      assert.doesNotMatch(byPath[".augment/rules/logging.md"].content, /---/);
      assert.match(
        byPath[".augment/rules/logging.md"].content,
        /structured logger/,
      );
      // always sorts ahead of agent-requested.
      assert.equal(rules[0].scope, "always");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bounds each rule to the byte cap", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ce-rules-cap-"));
    try {
      writeFileSync(path.join(root, "AGENTS.md"), "x".repeat(10_000));
      const rules = loadWorkspaceRules(root, { maxBytesPerRule: 500 });
      assert.equal(rules.length, 1);
      assert.ok(rules[0].content.length <= 500);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies source ACLs before returning workspace rules", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ce-rules-acl-"));
    try {
      const rulesDir = path.join(root, ".augment", "rules");
      mkdirSync(rulesDir, { recursive: true });
      writeFileSync(path.join(root, "AGENTS.md"), "root-secret-rule\n");
      writeFileSync(path.join(rulesDir, "public.md"), "public-rule\n");
      writeFileSync(path.join(rulesDir, "private.md"), "private-secret-rule\n");

      const allowlisted = loadWorkspaceRules(root, {
        sourceAccess: {
          defaultAccess: "deny",
          rules: [
            { pathPrefix: ".augment/rules/public.md", effect: "allow" },
          ],
        },
      });
      assert.deepEqual(
        allowlisted.map((rule) => rule.path),
        [".augment/rules/public.md"],
      );
      assert.match(allowlisted[0].content, /public-rule/);

      const deniedRoot = loadWorkspaceRules(root, {
        sourceAccess: {
          defaultAccess: "allow",
          rules: [{ pathPrefix: "AGENTS.md", effect: "deny" }],
        },
      });
      assert.equal(
        deniedRoot.some((rule) => rule.path === "AGENTS.md"),
        false,
      );
      assert.equal(
        deniedRoot.some((rule) => rule.content.includes("root-secret-rule")),
        false,
      );

      const multiRoot = loadWorkspaceRules(root, {
        sourcePathPrefix: "main",
        sourceAccess: {
          defaultAccess: "allow",
          rules: [{ pathPrefix: "main/AGENTS.md", effect: "deny" }],
        },
      });
      assert.equal(
        multiRoot.some((rule) => rule.path === "main/AGENTS.md"),
        false,
      );
      assert.ok(
        multiRoot.every((rule) => rule.path.startsWith("main/")),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("formats a bounded markdown preamble", () => {
    const section = formatRulesSection(
      [
        { path: "AGENTS.md", name: "AGENTS.md", content: "Rule body.", scope: "always" },
      ],
      undefined,
    );
    assert.match(section, /# Workspace rules/);
    assert.match(section, /## Rule: AGENTS\.md \(always\)/);
    assert.match(section, /source: AGENTS\.md/);
    assert.match(section, /Rule body\./);
    // Char cap truncates.
    const capped = formatRulesSection(
      [
        { path: "AGENTS.md", name: "AGENTS.md", content: "x".repeat(400), scope: "always" },
      ],
      120,
    );
    assert.ok(capped.length <= 120);
  });

  it("returns an empty string when there are no rules", () => {
    assert.equal(formatRulesSection([]), "");
  });

  it("rejects a rule file that symlinks outside the workspace root", () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "ce-rules-sec-"));
    const root = path.join(sandbox, "repo");
    const outside = path.join(sandbox, "outside");
    mkdirSync(path.join(root, ".augment", "rules"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    const secret = path.join(outside, "secret.md");
    writeFileSync(secret, "# Secret\n\nexfiltrated contents\n");
    // A legitimate in-root rule plus a malicious symlink escaping the root.
    writeFileSync(
      path.join(root, "AGENTS.md"),
      "# Conventions\n\nUse tabs.\n",
    );
    try {
      symlinkSync(secret, path.join(root, ".augment", "rules", "leak.md"));
    } catch {
      // Symlink creation can fail on some platforms; skip if unsupported.
      rmSync(sandbox, { recursive: true, force: true });
      return;
    }
    const rules = loadWorkspaceRules(root);
    // The in-root convention file is loaded; the escaping symlink is not.
    assert.ok(rules.some((rule) => rule.path === "AGENTS.md"));
    assert.equal(
      rules.some((rule) => rule.content.includes("exfiltrated")),
      false,
    );
    rmSync(sandbox, { recursive: true, force: true });
  });
});
