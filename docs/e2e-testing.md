# e2e-testing

The `e2e-testing` workflow is located at [.github/workflows/e2e-testing.yml](/oncoursesystems/workflows/tree/main/.github/workflows/e2e-testing.yml).

This workflow provides agentic end-to-end UI testing using Claude AI and [agent-browser](https://github.com/anthropics/agent-browser). Tests are written in markdown files with YAML frontmatter, making them human-readable and easy to maintain. Claude interprets the test steps and executes them using browser automation.

This depends on the following actions:
- [anthropics/claude-code-action](https://github.com/anthropics/claude-code-action)
- [actions/checkout](https://github.com/marketplace/actions/checkout)
- [actions/setup-node](https://github.com/marketplace/actions/setup-node)
- [actions/upload-artifact](https://github.com/marketplace/actions/upload-artifact)

## Inputs

### `runs-on`

**Optional** The type of runner to use for the job

**Default** `k8s-linux`

### `test-dir`

**Optional** Directory containing test markdown files

**Default** `./tests`

### `base-url`

**Required** Base URL for the application under test

### `filter`

**Optional** Filter tests by file name glob pattern (e.g., `login*`, `*auth*.test.md`)

**Default** `""`

### `tags`

**Optional** Filter tests by tags (comma-separated). Test must have ALL specified tags to run.

**Default** `""`

### `timeout`

**Optional** Test timeout in milliseconds

**Default** `120000`

### `screenshot-mode`

**Optional** Screenshot capture mode: `always`, `on-failure`, `never`

**Default** `on-failure`

### `fail-fast`

**Optional** Stop on first test failure

**Default** `false`

### `secrets-json`

**Optional** JSON object mapping secret names to values for credential interpolation in tests

**Default** `{}`

### `model`

**Optional** Claude model to use

**Default** `sonnet`

### `pr-number`

**Optional** Pull request number (for PR comments and auto-detecting changed files)

### `max-turns`

**Optional** Maximum number of turns for the Claude model

**Default** `200`

## Outputs

### `result`

Overall test result: `passed`, `failed`, or `unknown`

### `passed`

Number of passed tests

### `failed`

Number of failed tests

### `test_count`

Number of test files detected after filtering

## Secrets

### `CLAUDE_TOKEN`

**Required** Claude Code OAuth token for authentication

## Test File Format

Test files use markdown with YAML frontmatter. Files must have `.test.md` or `.e2e.md` extension.

```markdown
---
name: Login Flow Test
tags:
  - smoke
  - auth
timeout: 60000
dependsOn: []
profile: null
saveProfile: authenticated
---

## Steps

1. Navigate to {{BASE_URL}}/login
2. Fill in the username field with {{USERNAME}}
3. Fill in the password field with {{PASSWORD}}
4. Click the "Sign In" button
5. **Assert**: User is redirected to the dashboard
6. **Assert**: Welcome message displays the user's name
```

### Frontmatter Options

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Test name displayed in reports |
| `tags` | array | Tags for filtering (supports `- item` or `[item1, item2]` syntax) |
| `timeout` | number | Test-specific timeout in milliseconds |
| `dependsOn` | array | Test names that must pass before this test runs |
| `profile` | string | Load browser state from a saved profile |
| `saveProfile` | string | Save browser state to a profile after test passes |

## Filtering Behavior

The workflow supports intelligent test filtering based on context:

| Context | Behavior |
|---------|----------|
| **PR + tags** | Union: runs changed test files OR tests matching tags |
| **PR only** | Only runs test files changed in the PR |
| **Tags only** | Only runs tests matching all specified tags |
| **Neither** | Runs all test files |
| **+ filter** | Name/glob filter applies as intersection on any of the above |

This allows you to:
- Run only changed tests during PR review
- Always include smoke tests even if not changed
- Run specific test suites for deployments

## Usage

### Basic PR Workflow

```yaml
name: E2E Tests

on:
  pull_request:
    branches: [main]

jobs:
  e2e:
    uses: oncoursesystems/workflows/.github/workflows/e2e-testing.yml@main
    with:
      base-url: https://preview-${{ github.event.pull_request.number }}.example.com
    secrets:
      CLAUDE_TOKEN: ${{ secrets.CLAUDE_TOKEN }}
```

This runs only the test files that were changed in the PR.

### PR Workflow with Smoke Tests

```yaml
name: E2E Tests

on:
  pull_request:
    branches: [main]

jobs:
  e2e:
    uses: oncoursesystems/workflows/.github/workflows/e2e-testing.yml@main
    with:
      base-url: https://preview-${{ github.event.pull_request.number }}.example.com
      tags: smoke
    secrets:
      CLAUDE_TOKEN: ${{ secrets.CLAUDE_TOKEN }}
```

This runs changed test files PLUS all tests tagged with `smoke`.

### Deployment Smoke Tests

```yaml
name: Post-Deploy Verification

on:
  deployment:
    types: [completed]

jobs:
  smoke-tests:
    if: github.event.deployment.environment == 'production'
    uses: oncoursesystems/workflows/.github/workflows/e2e-testing.yml@main
    with:
      base-url: https://www.example.com
      tags: smoke
    secrets:
      CLAUDE_TOKEN: ${{ secrets.CLAUDE_TOKEN }}
```

### With Authentication Secrets

```yaml
name: E2E Tests

on:
  pull_request:
    branches: [main]

jobs:
  e2e:
    uses: oncoursesystems/workflows/.github/workflows/e2e-testing.yml@main
    with:
      base-url: https://preview-${{ github.event.pull_request.number }}.example.com
      tags: smoke
      secrets-json: |
        {
          "USERNAME": "${{ secrets.TEST_USERNAME }}",
          "PASSWORD": "${{ secrets.TEST_PASSWORD }}"
        }
    secrets:
      CLAUDE_TOKEN: ${{ secrets.CLAUDE_TOKEN }}
```

Use `{{USERNAME}}` and `{{PASSWORD}}` placeholders in your test files.

### Run Specific Test File

```yaml
jobs:
  e2e:
    uses: oncoursesystems/workflows/.github/workflows/e2e-testing.yml@main
    with:
      base-url: https://staging.example.com
      filter: "checkout*.test.md"
    secrets:
      CLAUDE_TOKEN: ${{ secrets.CLAUDE_TOKEN }}
```

### Full Configuration Example

```yaml
name: E2E Tests

on:
  pull_request:
    branches: [main]
  workflow_dispatch:
    inputs:
      tags:
        description: 'Test tags to run'
        required: false
        default: ''

jobs:
  e2e:
    uses: oncoursesystems/workflows/.github/workflows/e2e-testing.yml@main
    with:
      runs-on: ubuntu-latest
      test-dir: ./e2e-tests
      base-url: https://preview-${{ github.event.pull_request.number }}.example.com
      tags: ${{ github.event.inputs.tags || 'smoke' }}
      timeout: 180000
      screenshot-mode: on-failure
      fail-fast: false
      model: sonnet
      max-turns: 300
      secrets-json: |
        {
          "USERNAME": "${{ secrets.TEST_USERNAME }}",
          "PASSWORD": "${{ secrets.TEST_PASSWORD }}",
          "API_KEY": "${{ secrets.TEST_API_KEY }}"
        }
    secrets:
      CLAUDE_TOKEN: ${{ secrets.CLAUDE_TOKEN }}
```

## Artifacts

The workflow uploads the following artifacts:

- **agentic-ui-tests-screenshots** - Screenshots captured during test execution (retention: 7 days)
- **agentic-ui-tests-report** - JSON test results report (retention: 30 days)

## Test Results

Results are reported in multiple ways:

1. **GitHub Step Summary** - Test discovery and results table
2. **PR Comment** - Concise summary posted to the pull request
3. **JSON Report** - Detailed results in `test-results.json` artifact

Example PR comment:

```
## 🧪 E2E Test Results

| Status | Total | Passed | Failed |
|--------|-------|--------|--------|
| ✅ | 5 | 5 | 0 |

All tests passed successfully.
```
