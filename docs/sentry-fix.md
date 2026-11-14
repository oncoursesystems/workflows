# sentry-fix

The `sentry-fix` workflow is located at [.github/workflows/sentry-fix.yml](/oncoursesystems/workflows/tree/main/.github/workflows/sentry-fix.yml). Its source is the `ai-review` package, under [ai-review/src/sentry](/oncoursesystems/workflows/tree/main/ai-review/src/sentry).

Once a week, the workflow takes a repository's most frequent production Sentry issues and has Claude try to fix each one. A confident fix becomes a normal pull request. Every issue it attempts gets a Sentry note, with the pull request link or with Claude's analysis. When the pull request merges, and again when a release ships it, the workflow updates the labels and resolves the issue in that exact release.

## How a run works

1. **Rank.** The `plan` job asks Sentry for the unresolved issues in the configured `environment`, across every configured project together, sorted by their event count in the `period`. The `count` Sentry returns with `statsPeriod` and `environment` is the count in that period and environment, not the lifetime count.
2. **Walk.** From the top of the ranking, each issue is checked against the rules below until `limit` issues are attempted. A skipped issue does not use up the limit, so the next one takes its place. The plan job writes nothing.
3. **Fix.** A matrix job runs the fixer on each attempted issue, two at a time. The fixer is `claude-opus-5-5` with a $10 budget per issue. It runs on the Claude subscription and moves to the Claude API through workload identity federation when the subscription hits a usage limit, the same way [ai-review](ai-review.md) does. The fixer edits the checkout and never commits.
4. **Gate.** A pull request opens only when all of these hold:
    - Claude answered `fixed` at `high` or `medium` confidence.
    - Every project command it ran passed, and each one is a command from the config. A project with commands must run at least one.
    - The working tree has changes, and every changed path is inside the project's `roots`.
    - No changed path is protected: `.github/`, `.claude/`, any `CLAUDE.md`, `AGENTS.md`, `REVIEW.md`, `review-policy.yml`, `CODEOWNERS`, `.npmrc`, `nuget.config`, or a lockfile.
    - Every change is a regular file, not a symlink or a submodule, and no file holds a credential the fixer could see.

    Anything else counts as no fix.
5. **Publish.** The `publish` job runs on a fresh runner. For a fix, it commits the changes through the GitHub API as the bot app, pushes the branch `sentry-fix/<short id>`, and opens a ready pull request with the `sentry-autofix` label. Because the bot opens it, the repository's `pull_request` workflows (risk-tier, ai-review, CI) run on it. GitHub requests reviews from `CODEOWNERS`. Nobody is assigned. For no fix, it posts Claude's analysis and the gate's reasons as a Sentry note and opens nothing.
6. **Merge.** The `sentry-fix-merged` action, on a closed pull request, adds `sentry-fix-merged` to a merged auto-fix pull request and posts a merged note.
7. **Release.** The `sentry-fix-release` action finds the `sentry-fix-merged` pull requests whose merge commit is between the previous tag and this one. It resolves each issue whose project reports the app with `inRelease` set to the exact release name, and swaps the label to `sentry-fix-released`. It never resolves an issue at pull request time or with "next release".

Every step converges on a rerun. A rerun reuses the branch and the open pull request, and posts no note twice.

### Which issues are skipped

The rules run in this order, and the first one that applies skips the issue.

| Reason | When |
| --- | --- |
| `open-pr` | An open auto-fix pull request has the issue's marker, or any open pull request mentions its short ID in the title or the body. |
| `fix-pending-release` | An auto-fix pull request for the issue merged and has not shipped. |
| `released-fix` | An auto-fix pull request for the issue shipped, and Sentry has not marked the issue `regressed` or `escalating`. |
| `rejected-pr` | An auto-fix pull request for the issue closed without merging, and the issue is not `regressed` or `escalating`. |
| `prior-no-fix` | An earlier run posted a no-fix note, and the issue is not `regressed` or `escalating`. |
| `not-in-repo` | Jev is at least 80% sure the fix is outside the repository, such as an `ORA-` error raised in PL/SQL, a network failure, or a browser extension. |
| `fixed-by-open-pr` | Jev is at least 80% sure that an open pull request touching the stack trace files already fixes it. Only the 3 pull requests touching the most of those files are asked about. |

Jev runs only on issues that pass the other rules. When a Jev question fails, the issue is attempted anyway and the failure is in the plan summary.

### Markers

Every auto-fix pull request body ends with `<!-- sentry-issue: <id> -->`, and the plan finds earlier attempts by it. Each Sentry note starts with a line the next run reads: `[sentry-fix] pr <url>`, `[sentry-fix] no-fix <date>`, or `[sentry-fix] merged <url>`.

## Security

Sentry event text is attacker-controlled, because the browser DSN is public and anyone can send an event.

- **Allowlisted context.** Only the issue title, the culprit, the thrown exception, up to 30 frames, the release, the platform, and the transaction path without its query string leave Sentry. Request data, user context, breadcrumbs, cookies, headers, frame variables, and the extra and context blobs never do, because they can hold student data.
- **Untrusted in the prompt.** The fixer gets the context inside `<untrusted_sentry_event>` and is told to treat it as data.
- **Separate jobs.** The fix job holds only the Claude credentials. Its checkout keeps no credentials. The bot token and the Sentry token live in the publish job, on another runner, which never runs repository code and checks the gate again against the config on the default branch.
- **Allowlisted env.** The fixer and the commands it runs get `PATH`, `HOME`, the locale, a few toolchain variables, the Claude auth variable, and the names in the project's `env`. Nothing that looks like a token, a key, a password, `GITHUB_*`, `ACTIONS_*`, `INPUT_*` or `RUNNER_*` gets through, even when the config lists it.
- **Tools.** The fixer has `Read`, `Grep`, `Glob`, `Edit` and `Write`, with edits allowed only under the project roots, and `Bash` for `git diff`, `git status` and the project's exact commands. It has no web access.

The project commands run repository code that the fixer can change, so treat the fix job's Claude credentials as exposed to it. Give the federation workspace a spend limit.

## Config

The calling repository keeps its config at `.github/sentry-fix.yml` on the default branch. The [example](../examples/sentry-fix.yml) has a full one.

| Key | Default | Meaning |
| --- | --- | --- |
| `limit` | `5` | Issues to attempt per run, from 1 to 20. |
| `environment` | `production` | Sentry environment to rank. |
| `period` | `7d` | Ranking period: `24h`, `7d` or `14d`. |
| `projects[].slug` | | Sentry project slug. |
| `projects[].description` | | What code reports to the project. The fixer and Jev read it. |
| `projects[].roots` | | Directories the fix may change, relative to the repository root. `.` is the whole repository. |
| `projects[].commands` | `[]` | Exact commands the fixer may run to build and test, from the repository root. Write them so they need no `cd`, such as `npm --prefix client/web test`. |
| `projects[].env` | `[]` | Extra environment variable names the commands need, such as `NUGET_PACKAGES`. |
| `apps[].name` | | App name the release step passes. |
| `apps[].release` | | Sentry release name template with `{version}`, such as `OnCourse.Web@{version}`. |
| `apps[].projects` | | The project slugs that report this app's release. |

## Inputs

### `config-path`

**Optional** Path of the config, read from the default branch. **Default** `.github/sentry-fix.yml`

### `dry-run`

**Optional** `true` ranks, applies the rules and Jev triage, and prints the walk to the job summary: each issue, its event count, the decision and the reason. No fixer runs, and nothing is written to GitHub or Sentry. **Default** `false`

### `runs-on`

**Optional** Runner label for every job. **Default** `linux`

### `node-version`, `dotnet-version` and `global-json-file`

**Optional** The toolchain the project commands need. The fix job sets it up after the fixer's own Node.js 24, so the project's version comes first on `PATH`.

### `sentry-org`

**Required** Sentry organization slug.

### `bot-client-id`

**Required** Client ID of the GitHub App that pushes the branches and opens the pull requests. In OnCourse repositories it is the org variable `GH_APP_CLIENT_ID`. The app needs `contents: write`, `pull-requests: write` and `issues: write`.

### `anthropic-federation-rule-id`, `anthropic-organization-id`, `anthropic-service-account-id` and `anthropic-workspace-id`

**Optional** The workload identity federation rule to fall back on, as in [ai-review](ai-review.md). The rule must accept the `sentry-fix.yml` workflow. Without them, a usage limit ends that issue's fixer with a warning, and nothing is published for it.

## Secrets

- `sentry-token`: a Sentry auth token with `project:read`, `event:read` and `event:write`.
- `typesafe-api-key`: TypeSafe API key for Jev.
- `claude-code-oauth-token`: Claude Code OAuth token the fixer runs on.
- `bot-app-private-key`: private key of the bot app.

## The merge and release actions

`sentry-fix-merged` takes `github-token`, `sentry-token` and `sentry-org`. Run it on `pull_request: closed`.

`sentry-fix-release` takes `github-token`, `sentry-token`, `sentry-org`, `app`, `tag`, `previous-tag`, and either `version` or `release`. With `version`, the release name is the app's template filled in. With `release`, the name is used as given. Mobile passes `release` after the store build, because only then does the version have its `+build` suffix. Run it after the release exists in Sentry. The step output `release` is the name it used.

When two apps report the same Sentry project, the issue resolves in the release of whichever app ships the fix first, and the label moves to `sentry-fix-released` then.

## Run the dry run locally

```zsh
cd ai-review
npm ci
SENTRY_TOKEN=... TYPESAFE_API_KEY=... npm run sentry -- --dry-run --org <sentry org> --config ~/path/to/sentry-fix.yml --repo oncoursesystems/oncourse-systems
```

It reads `GH_TOKEN`, or `gh auth token`, for GitHub. It prints the walk table and writes nothing.
