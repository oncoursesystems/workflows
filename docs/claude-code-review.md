# claude-code-review

The `claude-code-review` workflow is located at [.github/workflows/claude-code-review.yml](/oncoursesystems/workflows/tree/main/.github/workflows/claude-code-review.yml).

Automated code review for pull requests using Claude AI. Analyzes code changes for quality, bugs, and performance, then posts a GitHub Pull Request Review with inline line comments. Also updates the PR title and description based on the changes.

This depends on the following actions:
- [anthropics/claude-code-action](https://github.com/anthropics/claude-code-action)
- [actions/checkout](https://github.com/marketplace/actions/checkout)

## Features

- **Smart model selection**: Automatically picks a smaller model for small PRs and a larger model for big PRs (configurable threshold and models, or override with a specific model)
- **PR title/description updates**: Generates a descriptive title and structured description from the diff
- **Inline review comments**: Posts findings as native GitHub PR review comments on specific lines
- **Old review cleanup**: Automatically resolves previous review threads and dismisses old reviews on each new push
- **Plugin support**: Optional support for Claude Code plugins from public or private registries
- **Custom instructions**: Append repo-specific review guidance via the `custom-prompt` input

## Inputs

### `runs-on`

**Optional** The type of runner to use for the job

**Default** `ubuntu-latest`

### `anthropic-model`

**Optional** Override the auto-selected Claude model (e.g., `claude-opus-4-6`). Leave empty for automatic PR-size-based selection.

**Default** `""` (auto-select)

### `custom-prompt`

**Optional** Additional instructions appended to the review prompt. Use for repo-specific conventions or focus areas.

**Default** `""`

### `plugins`

**Optional** Claude Code plugins to use (e.g., `thayer-code-agent@thayer-code-agent`)

**Default** `""`

### `allowed-tools`

**Optional** Tools allowed for Claude to use

**Default** `Read,Grep,Glob,Bash(gh issue view:*),Bash(gh search:*),Bash(gh issue list:*),Bash(gh pr comment:*),Bash(gh pr diff:*),Bash(gh pr view:*),Bash(gh pr list:*),Bash(gh pr edit:*),Bash(gh api:*)`

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

**Optional** Authenticated plugin marketplace URL(s). Use for private registries that require a token (e.g., `https://x-access-token:<token>@github.com/Org/registry.git`).

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
  code-review:
    if: >
      (github.event_name == 'pull_request' && github.event.pull_request.draft == false) ||
      (github.event_name == 'issue_comment' &&
       github.event.issue.pull_request &&
       contains(github.event.comment.body, '@claude'))
    uses: oncoursesystems/workflows/.github/workflows/claude-code-review.yml@main
    secrets:
      CLAUDE_TOKEN: ${{ secrets.CLAUDE_TOKEN }}
```

### With Custom Options

```yaml
jobs:
  code-review:
    if: >
      (github.event_name == 'pull_request' && github.event.pull_request.draft == false) ||
      (github.event_name == 'issue_comment' &&
       github.event.issue.pull_request &&
       contains(github.event.comment.body, '@claude'))
    uses: oncoursesystems/workflows/.github/workflows/claude-code-review.yml@main
    with:
      anthropic-model: claude-opus-4-6
      custom-prompt: |
        This repo uses Dapper for data access — check for parameterized queries.
        ExtJS frontend follows the patterns in app/view/shared.
    secrets:
      CLAUDE_TOKEN: ${{ secrets.CLAUDE_TOKEN }}
```

### With Private Plugin Registry

```yaml
jobs:
  code-review:
    uses: oncoursesystems/workflows/.github/workflows/claude-code-review.yml@main
    with:
      plugins: "thayer-code-agent@thayer-code-agent"
    secrets:
      CLAUDE_TOKEN: ${{ secrets.CLAUDE_TOKEN }}
      PLUGIN_MARKETPLACE_AUTH: "https://x-access-token:${{ secrets.PLUGIN_REGISTRY_TOKEN }}@github.com/YourOrg/your-registry.git"
```

## How It Works

1. **Model selection**: Fetches the PR's line count via the GitHub API. If `anthropic-model` is set, uses that. Otherwise, picks `small-pr-model` or `large-pr-model` based on the `small-pr-threshold`.

2. **Old review cleanup**: Resolves any open review threads from previous bot reviews tagged "Code Review", then dismisses and deletes the old review submissions. This keeps the PR timeline clean on each new push.

3. **PR title/description update**: Claude reads the diff and generates a concise title (preserving any leading ticket number) and a structured description with summary, files changed, DB changes, dev notes, breaking changes, and test plan sections.

4. **Code review**: Claude reads the diff and relevant source files, then submits a GitHub Pull Request Review with inline comments on specific lines. Findings use severity prefixes: **Bug**, **Performance**, **Style**, **Suggestion**.

## Review Scope

The code review focuses on:
- Code quality and best practices
- Potential bugs and logic errors
- Performance considerations
- Test coverage

It deliberately skips OWASP-style security findings (XSS, injection, auth) since those are handled by the [claude-security-review](claude-security-review.md) workflow.
