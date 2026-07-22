import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderCiTemplate, type CiTemplateProvider } from "../src/ci/templates.js";

const expectations: Array<{
  provider: CiTemplateProvider;
  provenance: string;
  runId: string;
}> = [
  { provider: "github", provenance: "github-actions", runId: "$GITHUB_RUN_ID" },
  { provider: "gitlab", provenance: "gitlab-ci", runId: "$CI_PIPELINE_ID" },
  { provider: "bitbucket", provenance: "bitbucket-pipelines", runId: "$BITBUCKET_BUILD_NUMBER" },
];

describe("CI workflow templates", () => {
  for (const expectation of expectations) {
    it(`renders an auditable ${expectation.provider} sync workflow`, () => {
      const template = renderCiTemplate(expectation.provider);
      assert.match(template, /POST "\$CONTEXTENGINE_URL\/ci\/sync"/);
      assert.match(template, /Authorization: Bearer \$CONTEXTENGINE_CI_TOKEN/);
      assert.match(template, /X-ContextEngine-Delivery:/);
      assert.ok(template.includes(expectation.runId));
      assert.ok(template.includes(`\\"provider\\":\\"${expectation.provenance}\\"`));
      for (const field of ["run_id", "ref", "commit", "repository"]) {
        assert.ok(template.includes(`\\"${field}\\"`));
      }
      assert.equal(template.endsWith("\n"), true);
    });
  }
});
