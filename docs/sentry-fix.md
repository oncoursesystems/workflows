# sentry-fix

The `sentry-fix` workflow is located at [.github/workflows/sentry-fix.yml](/oncoursesystems/workflows/tree/main/.github/workflows/sentry-fix.yml). Its source is the `ai-review` package, under [ai-review/src/sentry](/oncoursesystems/workflows/tree/main/ai-review/src/sentry).

Once a week, the workflow takes a repository's most frequent production Sentry issues and has Claude try to fix each one. A confident fix becomes a normal pull request. Every issue it attempts gets a Sentry note, with the pull request link or with Claude's analysis. When the pull request merges, and again when a release ships it, the workflow updates the labels and resolves the issue in that exact release.

## How a run works

1. **Rank.** The `plan` job asks Sentry for the unresolved issues in the configured `environment`, across every configured project together, sorted by their event count in the `period`. The `count` Sentry returns with `statsPeriod` and `environment` is the count in that period and environment, not the lifetime count.
2. **Walk.** From the top of the ranking, each issue is checked against the rules below until `limit` issues are attempted. A skipped issue does not use up the limit, so the next one takes its place. The plan job writes nothing to GitHub or Sentry. It uploads the plan as the `sentry-fix-plan` artifact and outputs only its SHA-256 and the id and short ID of each issue. The fix and publish jobs check that hash before they read the plan.
3. **Fix.** A matrix job runs the fixer on each attempted issue, two at a time, in the job's own process (see [Security](#security)). The fixer is `claude-opus-5-5` with a $10 budget per issue, on the Claude subscription only. It can only read and edit files, so it runs no build or test. It adds a regression test beside the existing tests, and the pull request's CI runs it. The fixer edits the checkout and never commits.
4. **Gate.** A pull request opens only when all of these hold:
    - Claude answered `fixed` at `high` or `medium` confidence.
    - The working tree has changes, and every changed tracked path is inside the project's `roots`. New untracked files outside the roots, such as a `TestResults` folder, are build output and are ignored.
    - No changed path is protected: `.github/`, `.claude/`, any `CLAUDE.md`, `AGENTS.md`, `REVIEW.md`, `review-policy.yml`, `CODEOWNERS`, `.npmrc`, `nuget.config`, or a lockfile.
    - No changed path is a build file that pull request CI would run before review: `package.json`, project, solution, `.props` and `.targets` files, `Directory.Build.*`, `global.json`, `.config/dotnet-tools.json`, a `Dockerfile`, a shell script, or a webpack, vite, jest, karma, eslint, babel, metro, tsconfig or app config.
    - Every change is a regular file, not a symlink or a submodule, and no file holds the Claude token.

    Anything else counts as no fix. A fixer that runs out of budget, turns or time also counts as no fix.
5. **Publish.** The `publish` job holds the bot and Sentry tokens and runs no repository code. For a fix, it commits the changes through the GitHub API as the bot app, points the branch `sentry-fix/<short id>` at the commit, and opens a ready pull request with the `sentry-autofix` label. Because the bot opens it, the repository's `pull_request` workflows (risk-tier, ai-review, CI) run on it. GitHub requests reviews from `CODEOWNERS`. Nobody is assigned. When the pull request is already open and someone else pushed to its branch, publish leaves the branch alone and refreshes only the body. The body says the build and the tests are verified by the pull request's CI checks. For no fix, it posts the gate's reasons and Claude's analysis as a Sentry note, and opens nothing.
6. **Merge.** The `sentry-fix-merged` action, on a closed pull request, adds `sentry-fix-merged` to a merged auto-fix pull request and posts a merged note.
7. **Release.** The `sentry-fix-release` action finds the merged `sentry-autofix` pull requests without `sentry-fix-released` whose merge commit is between the previous tag and this one. A missing `sentry-fix-merged` label does not matter. When it finds one, it creates the release in the app's projects, because Sentry resolves an issue only in a release it knows and an app reports its release only after it deploys. Then it resolves each issue whose project reports the app with `inRelease` set to the exact release name, and swaps the label to `sentry-fix-released`. It never resolves an issue at pull request time or with "next release". A pull request that fails, for example because its Sentry issue was deleted, is a warning, and the rest still resolve. The step fails only when every pull request in it failed.

Every step converges on a rerun. A rerun reuses the branch and the open pull request, and posts no note twice.

An infrastructure error leaves an issue with no note, so the next run tries it again. That covers a usage limit, a checkout at the wrong commit, a git error, and a run that changed `.git/config` or a `.gitattributes`.

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

Every auto-fix pull request body ends with `<!-- sentry-issue: <id> -->`, and the plan finds earlier attempts by it. Only a marker on the last non-empty line counts. Sentry and agent text earlier in the body cannot open an HTML comment, because every `<!--` in it gets a zero-width joiner. The merge and release actions also check that the marker's issue matches the branch `sentry-fix/<short id>`, and skip the pull request with a warning when it does not.

Each Sentry note starts with a line the next run reads: `[sentry-fix] pr <url>`, `[sentry-fix] no-fix <date> run <workflow run id>`, or `[sentry-fix] merged <url>`. A no-fix note is posted once per workflow run. Notes from before the run id, `[sentry-fix] no-fix <date>`, still count.

## Security

Sentry event text is attacker-controlled, because the browser DSN is public and anyone can send an event. The fixer has no shell, so it can only read and edit files, and it runs no repository code. A prompt injection in an event can therefore produce a bad diff and nothing else. Before that diff merges, the gate checks it, the protected paths limit it, the pull request's CI builds and tests it, ai-review reviews it, and a `CODEOWNERS` reviewer approves it.

The Claude OAuth token is held in the fix job only. The agent session gets it through an env allowlist: the paths, the locale, `CI` and the token. Nothing that looks like a GitHub, Sentry or Typesafe credential reaches it.

- **Allowlisted context.** Only the issue title, the culprit, the thrown exception, up to 30 frames, the release, the platform, and the transaction path without its query string leave Sentry. Request data, user context, breadcrumbs, cookies, headers, frame variables, and the extra and context blobs never do, because they can hold student data.
- **Untrusted in the prompt.** The fixer gets the context inside `<untrusted_sentry_event>` and is told to treat it as data.
- **Separate jobs.** The fix job holds only the Claude OAuth token. It has no `id-token: write`, so no OIDC token can be minted in it. Its checkout keeps no credentials. The bot token and the Sentry token live in the publish job, which never runs repository code. The publish job takes the issue, the project and the base commit from the hashed plan, and checks the gate again against the config on the default branch.
- **Tools.** The fixer has `Read`, `Grep`, `Glob`, `Edit` and `Write`, and no `Bash`, git command or web access. Edits are allowed only under the project roots. Reads are not listed as allowed, because a bare rule would allow reads everywhere. Under `dontAsk`, a read inside the working directory is allowed and one outside it is denied.

The harness's own git calls run with only `PATH` and `HOME`, no system or global config, and hooks, fsmonitor and submodule recursion off. Before the session, the harness fingerprints `.git/config` and every `.gitattributes` git reads for a tracked file. If any changed, the result is failed and nothing is collected. It reads the changes with `git status --porcelain=v2` and direct reads of regular files, never through a symlink.

### What is left

- **A wrong fix.** A fix that passes the gate is still Claude's code. It opens as a normal pull request, and pull request CI runs on it with the repository's secrets before review. Build files are protected for that reason, but a test or source file inside the roots still runs in CI. Review it like any other pull request.
- **The Claude token and the runner.** The fixer shares the runner with other jobs and holds the token in its process env, but it runs nothing it wrote. Rotate the token if a fixer run looks wrong, and keep it on an account used for nothing else.

### Why there is no API fallback

The fixer runs on the Claude subscription only. A fallback to the Claude API through workload identity federation would need `id-token: write` on the fix job. Instead, a usage limit leaves the issue with no note, and the next run tries it again. ai-review keeps its fallback.

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
| `apps[].name` | | App name the release step passes. |
| `apps[].release` | | Sentry release name template with `{version}`, such as `OnCourse.Web@{version}`. |
| `apps[].projects` | | The project slugs that report this app's release. |

## Inputs

### `config-path`

**Optional** Path of the config, read from the default branch. **Default** `.github/sentry-fix.yml`

### `limit`

**Optional** Issues to attempt in this run, from 1 to 20. A manual run uses it to try one issue first, or to fix more between the weekly runs. **Default** empty, which uses the config's `limit`

### `dry-run`

**Optional** `true` ranks, applies the rules and Jev triage, and prints the walk to the job summary: each issue, its event count, the decision and the reason. No fixer runs, and nothing is written to GitHub or Sentry. **Default** `false`

### `runs-on`

**Optional** Runner label for every job. **Default** `linux`

### `sentry-org`

**Required** Sentry organization slug.

### `bot-client-id`

**Required** Client ID of the GitHub App that pushes the branches and opens the pull requests. In OnCourse repositories it is the org variable `GH_APP_CLIENT_ID`. The app needs `contents: write`, `pull-requests: write` and `issues: write`.

## Secrets

- `sentry-token`: a Sentry auth token with `project:read`, `event:read` and `event:write`. The release action also needs `project:releases`.
- `typesafe-api-key`: TypeSafe API key for Jev.
- `claude-code-oauth-token`: Claude Code OAuth token the fixer runs on.
- `bot-app-private-key`: private key of the bot app.

## The merge and release actions

`sentry-fix-merged` takes `github-token`, `sentry-token` and `sentry-org`. Run it on `pull_request: closed`.

`sentry-fix-release` takes `github-token`, `sentry-token`, `sentry-org`, `app`, `tag`, `previous-tag`, and either `version` or `release`. With `version`, the release name is the app's template filled in. With `release`, the name is used as given. Mobile passes `release` after the store build, because only then does the version have its `+build` suffix. Run it after the release is tagged, with `continue-on-error: true`, so a Sentry outage never blocks a release. The step output `release` is the name it used.

When two apps report the same Sentry project, the issue resolves in the release of whichever app ships the fix first, and the label moves to `sentry-fix-released` then.

## Run the dry run locally

```zsh
cd ai-review
npm ci
SENTRY_TOKEN=... TYPESAFE_API_KEY=... npm run sentry -- --dry-run --org <sentry org> --config ~/path/to/sentry-fix.yml --repo oncoursesystems/oncourse-systems
```

It reads `GH_TOKEN`, or `gh auth token`, for GitHub. It prints the walk table and writes nothing.
