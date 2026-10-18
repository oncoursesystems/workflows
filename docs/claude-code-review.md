# claude-code-review

The `claude-code-review` workflow is located at [.github/workflows/claude-code-review.yml](/oncoursesystems/workflows/tree/main/.github/workflows/claude-code-review.yml).

Automated code review for pull requests using Claude AI. Analyzes code changes for quality, bugs, and performance, then posts a GitHub Pull Request Review with inline line comments. Also updates the PR title and description based on the changes.

This depends on the following actions:
- [anthropics/claude-code-action](https://github.com/anthropics/claude-code-action)
- [actions/checkout](https://github.com/marketplace/actions/checkout)

## Features

- **Smart model selection**: Automatically picks a smaller model for small PRs and a larger model for big PRs (configurable threshold and models, or override with a specific model)
- **PR title/description updates**: Generates a descriptive title and structured description from the diff
- **One review per run**: Claude returns its findings as structured output, and a workflow step posts them as a single GitHub PR review. Findings on lines the diff shows become inline comments. The rest are listed in the review body.
- **Read-only Claude**: Claude can read the code and the PR but cannot post, comment, or edit anything on GitHub itself
- **Old review cleanup**: Deletes the inline comments of previous code reviews, which removes their threads, and hides the old reviews as outdated on each run
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

**Default** `Read,Grep,Glob,Bash(gh issue view:*),Bash(gh search:*),Bash(gh issue list:*),Bash(gh pr diff:*),Bash(gh pr view:*),Bash(gh pr list:*)`

Keep this list read-only. The workflow posts the review and updates the PR, so Claude needs no write access.

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

### `GH_APP_ID`

**Optional** GitHub App ID. With `GH_APP_PRIVATE_KEY`, the workflow posts the review as that app, such as `oc-bot-ross[bot]`. Without it, the review posts as `github-actions[bot]`.

### `GH_APP_PRIVATE_KEY`

**Optional** Private key for the `GH_APP_ID` app.

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
      GH_APP_ID: ${{ secrets.GH_APP_ID }}
      GH_APP_PRIVATE_KEY: ${{ secrets.GH_APP_PRIVATE_KEY }}
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

2. **Old review cleanup**: Deletes the inline comments of previous bot reviews that start with "## Code Review", which removes their threads, and hides the old reviews as outdated. GitHub cannot dismiss a review that only comments, so hiding is what keeps them from piling up. This job also clears older stray bot reviews that carry neither review heading.

3. **PR title/description**: Claude reads the diff and writes a concise title (preserving any leading ticket number) and a structured description with summary, files changed, DB changes, dev notes, breaking changes, and test plan sections. A workflow step applies them to the PR.

4. **Code review**: Claude reads the diff and the PR head's source files, then returns its findings with severity prefixes **Bug**, **Performance**, **Style**, or **Suggestion**. A workflow step posts them as one GitHub Pull Request Review.

## Review Scope

The code review focuses on:
- Code quality and best practices
- Potential bugs and logic errors
- Performance considerations
- Test coverage

It deliberately skips OWASP-style security findings (XSS, injection, auth) since those are handled by the [claude-security-review](claude-security-review.md) workflow.
