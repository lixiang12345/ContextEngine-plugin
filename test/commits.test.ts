import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { commitsToChunks, type CommitSummary } from "../src/lineage/commits.js";

describe("commit lineage", () => {
  it("converts commits to searchable chunks", () => {
    const commits: CommitSummary[] = [
      {
        hash: "abc123def456",
        shortHash: "abc123d",
        author: "dev",
        date: "2026-07-01",
        subject: "Add payment webhook retry",
        files: ["src/payments.ts", "src/webhooks.ts"],
      },
    ];
    const chunks = commitsToChunks(commits);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].language, "git-commit");
    assert.ok(chunks[0].content.includes("payment webhook"));
    assert.ok(chunks[0].path.includes("abc123d"));
  });
});
