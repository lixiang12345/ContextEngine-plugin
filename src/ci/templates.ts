export type CiTemplateProvider = "github" | "gitlab" | "bitbucket";

const templates: Record<CiTemplateProvider, string> = {
  github: `name: ContextEngine sync

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  contextengine-sync:
    runs-on: ubuntu-latest
    steps:
      - name: Refresh ContextEngine source
        env:
          CONTEXTENGINE_URL: \${{ vars.CONTEXTENGINE_URL }}
          CONTEXTENGINE_CI_TOKEN: \${{ secrets.CONTEXTENGINE_CI_TOKEN }}
        run: |
          curl --fail-with-body --retry 3 -X POST "$CONTEXTENGINE_URL/ci/sync" \\
            -H "Authorization: Bearer $CONTEXTENGINE_CI_TOKEN" \\
            -H "X-ContextEngine-Delivery: $GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" \\
            -H 'Content-Type: application/json' \\
            --data "{\\"provider\\":\\"github-actions\\",\\"run_id\\":\\"$GITHUB_RUN_ID\\",\\"ref\\":\\"$GITHUB_REF_NAME\\",\\"commit\\":\\"$GITHUB_SHA\\",\\"repository\\":\\"$GITHUB_REPOSITORY\\"}"
`,
  gitlab: `contextengine-sync:
  stage: .post
  image: curlimages/curl:latest
  rules:
    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'
  script:
    - >-
      curl --fail-with-body --retry 3 -X POST "$CONTEXTENGINE_URL/ci/sync"
      -H "Authorization: Bearer $CONTEXTENGINE_CI_TOKEN"
      -H "X-ContextEngine-Delivery: $CI_PIPELINE_ID-$CI_JOB_ID"
      -H 'Content-Type: application/json'
      --data "{\\"provider\\":\\"gitlab-ci\\",\\"run_id\\":\\"$CI_PIPELINE_ID\\",\\"ref\\":\\"$CI_COMMIT_REF_NAME\\",\\"commit\\":\\"$CI_COMMIT_SHA\\",\\"repository\\":\\"$CI_PROJECT_PATH\\"}"
`,
  bitbucket: `pipelines:
  branches:
    main:
      - step:
          name: Refresh ContextEngine source
          image: curlimages/curl:latest
          script:
            - >-
              curl --fail-with-body --retry 3 -X POST "$CONTEXTENGINE_URL/ci/sync"
              -H "Authorization: Bearer $CONTEXTENGINE_CI_TOKEN"
              -H "X-ContextEngine-Delivery: $BITBUCKET_BUILD_NUMBER"
              -H 'Content-Type: application/json'
              --data "{\\"provider\\":\\"bitbucket-pipelines\\",\\"run_id\\":\\"$BITBUCKET_BUILD_NUMBER\\",\\"ref\\":\\"$BITBUCKET_BRANCH\\",\\"commit\\":\\"$BITBUCKET_COMMIT\\",\\"repository\\":\\"$BITBUCKET_REPO_FULL_NAME\\"}"
`,
};

export function renderCiTemplate(provider: CiTemplateProvider): string {
  return templates[provider];
}
