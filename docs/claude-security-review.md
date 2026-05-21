# claude-security-review

The `claude-security-review` workflow is located at [.github/workflows/claude-security-review.yml](/oncoursesystems/workflows/tree/main/.github/workflows/claude-security-review.yml).

Automated security review for pull requests using Claude AI. Performs a focused security analysis covering OWASP Top 10, secrets/credentials, input validation, and dependency security, then posts a GitHub Pull Request Review with inline line comments.

This depends on the following actions:
- [anthropics/claude-code-action](https://github.com/anthropics/claude-code-action)
- [actions/checkout](https://github.com/marketplace/actions/checkout)

## Features

- **Smart model selection**: Automatically picks a smaller model for small PRs and a larger model for big PRs (configurable threshold and models, or override with a specific model)
- **Severity ratings**: Findings are rated CRITICAL, HIGH, MEDIUM, or LOW
- **Inline review comments**: Posts findings as native GitHub PR review comments on specific lines
- **Old review cleanup**: Automatically resolves previous security review threads and dismisses old reviews on each new push
- **Plugin support**: Optional support for Claude Code plugins from public or private registries
- **Custom instructions**: Append repo-specific security guidance via the `custom-prompt` input
- **Scoped analysis**: Only reports security vulnerabilities — code quality, performance, and style issues are left to the [code review](claude-code-review.md) workflow

## Inputs

### `runs-on`

**Optional** The type of runner to use for the job

**Default** `ubuntu-latest`

### `anthropic-model`

**Optional** Override the auto-selected Claude model (e.g., `claude-opus-4-6`). Leave empty for automatic PR-size-based selection.

**Default** `""` (auto-select)

### `custom-prompt`

**Optional** Additional instructions appended to the security review prompt. Use for repo-specific security patterns or focus areas.

**Default** `""`

### `plugins`

**Optional** Claude Code plugins to use (e.g., `thayer-code-agent@thayer-code-agent`)

**Default** `""`

### `allowed-tools`

**Optional** Tools allowed for Claude to use

**Default** `Read,Grep,Glob,Bash(gh pr diff:*),Bash(gh pr view:*),Bash(gh api:*)`

### `small-pr-threshold`

**Optional** Line change threshold for model selection. PRs at or above this use the large model.

**Default** `200`

### `small-pr-model`

**Optional** Model for PRs under the threshold

**Default** `claude-haiku-4-5-20251001`

### `large-pr-model`

**Optional** Model for PRs at or above the threshold

**Default** `claude-sonnet-4-6`

## Secrets

### `CLAUDE_TOKEN`

**Required** Claude Code OAuth token for authentication

### `PLUGIN_MARKETPLACE_AUTH`

**Optional** Authenticated plugin marketplace URL(s). Use for private registries that require a token.

## Usage

```yaml
name: Claude PR Review

on:
  pull_request:
    types: [opened, synchronize, reopened]
  issue_comment:
    types: [created]

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.event.issue.number || github.ref }}
  cancel-in-progress: true

jobs:
  security-review:
    if: >
      (github.event_name == 'pull_request' && github.event.pull_request.draft == false) ||
      (github.event_name == 'issue_comment' &&
       github.event.issue.pull_request &&
       contains(github.event.comment.body, '@claude'))
    uses: oncoursesystems/workflows/.github/workflows/claude-security-review.yml@main
    secrets:
      CLAUDE_TOKEN: ${{ secrets.CLAUDE_TOKEN }}
```

### With Custom Security Focus

```yaml
jobs:
  security-review:
    uses: oncoursesystems/workflows/.github/workflows/claude-security-review.yml@main
    with:
      anthropic-model: claude-opus-4-6
      custom-prompt: |
        This repo handles PII and HIPAA data. Pay special attention to:
        - Data encryption at rest and in transit
        - Audit logging for data access
        - PHI exposure in logs or error messages
    secrets:
      CLAUDE_TOKEN: ${{ secrets.CLAUDE_TOKEN }}
```

## How It Works

1. **Model selection**: Fetches the PR's line count via the GitHub API. If `anthropic-model` is set, uses that. Otherwise, picks `small-pr-model` or `large-pr-model` based on the `small-pr-threshold`.

2. **Old review cleanup**: Resolves any open review threads from previous bot reviews tagged "Security Review", then dismisses and deletes the old review submissions. Cleanup uses different tags than the code review workflow, so the two don't interfere.

3. **Security analysis**: Claude reads the diff, then reads the full source files for any changed files that handle user input, authentication, database queries, or external APIs. It checks existing codebase patterns before flagging deviations.

4. **Review posting**: Submits a GitHub Pull Request Review with inline comments using severity prefixes: **[CRITICAL]**, **[HIGH]**, **[MEDIUM]**, **[LOW]**.

## Review Categories

- **OWASP Top 10**: SQL/NoSQL injection, XSS, broken auth, broken access control, security misconfiguration, insecure deserialization, SSRF
- **Secrets & Credentials**: Hardcoded keys, secrets in logs, sensitive data in URLs
- **Input Validation**: Missing validation, path traversal, command injection, ReDoS
- **Dependency Security**: Known vulnerable packages, unsafe configurations
