# claude-pr-review

The `claude-pr-review` workflow is located at [.github/workflows/claude-pr-review.yml](/oncoursesystems/workflows/tree/main/.github/workflows/claude-pr-review.yml).

This workflow provides automated code review for pull requests using Claude AI. It analyzes code changes for quality, security, and performance issues, then posts review comments directly on the PR.

This depends on the following actions:
- [anthropics/claude-code-action](https://github.com/anthropics/claude-code-action)
- [actions/checkout](https://github.com/marketplace/actions/checkout)

## Inputs

### `runs-on`

**Optional** The type of runner to use for the job

**Default** `k8s-linux`

### `anthropic-model`

**Optional** Claude model to use for the review

**Default** `claude-sonnet-4-6`

### `custom-prompt`

**Optional** Additional custom instructions for the review

**Default** `""`

### `allowed-tools`

**Optional** Tools allowed for Claude to use

**Default** `Bash(gh pr comment:*),Bash(gh pr review:*),Bash(gh pr diff:*),Bash(gh pr view:*),Read,Grep,Glob`

### `bun-path`

**Optional** Path to pre-installed Bun runtime (leave blank to let Claude install Bun)

**Default** `/home/runner/.bun/bin/bun`

## Secrets

### `CLAUDE_TOKEN`

**Required** Claude Code OAuth token for authentication

## Usage

```yaml
name: Claude PR Review

on:
  pull_request:
    types: [opened, synchronize, reopened]
  issue_comment:
    types: [created]

jobs:
  review:
    if: >
      github.event_name == 'pull_request' ||
      (github.event_name == 'issue_comment' &&
       github.event.issue.pull_request &&
       contains(github.event.comment.body, '@claude'))
    uses: oncoursesystems/workflows/.github/workflows/claude-pr-review.yml@main
    secrets:
      CLAUDE_TOKEN: ${{ secrets.CLAUDE_TOKEN }}
```

This triggers on PR events or when someone mentions `@claude` in a PR comment.

### With Custom Options

```yaml
name: Claude PR Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  review:
    uses: oncoursesystems/workflows/.github/workflows/claude-pr-review.yml@main
    with:
      anthropic-model: claude-opus-4-5
      custom-prompt: |
        Focus especially on SQL injection vulnerabilities.
        Ensure all database queries use parameterized statements.
    secrets:
      CLAUDE_TOKEN: ${{ secrets.CLAUDE_TOKEN }}
```

## Review Focus Areas

The workflow reviews code for:

1. **Code Quality**
   - Clean code principles and best practices
   - Proper error handling and edge cases
   - Code readability and maintainability

2. **Security**
   - Potential security vulnerabilities
   - Input sanitization
   - Authentication/authorization logic

3. **Performance**
   - Potential performance bottlenecks
   - Database query efficiency
   - Memory leaks or resource issues

## Plugins

The workflow uses the `pr-review-toolkit` plugin which provides specialized review agents:

- **code-reviewer** - Code quality and style analysis
- **pr-test-analyzer** - Test coverage evaluation
- **silent-failure-hunter** - Error handling detection
- **type-design-analyzer** - Type design review
- **comment-analyzer** - Comment accuracy verification
- **code-simplifier** - Code complexity analysis
