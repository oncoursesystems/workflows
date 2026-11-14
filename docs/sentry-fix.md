# sentry-fix

The `sentry-fix` workflow is located at [.github/workflows/sentry-fix.yml](/oncoursesystems/workflows/tree/main/.github/workflows/sentry-fix.yml). Its source is the `ai-review` package, under [ai-review/src/sentry](/oncoursesystems/workflows/tree/main/ai-review/src/sentry).

Once a week, the workflow takes a repository's most frequent production Sentry issues and has Claude try to fix each one. A confident fix becomes a normal pull request. Every issue it attempts gets a Sentry note, with the pull request link or with Claude's analysis. When the pull request merges, and again when a release ships it, the workflow updates the labels and resolves the issue in that exact release.

## How a run works

1. **Rank.** The `plan` job asks Sentry for the unresolved issues in the configured `environment`, across every configured project together, sorted by their event count in the `period`. The `count` Sentry returns with `statsPeriod` and `environment` is the count in that period and environment, not the lifetime count.
2. **Walk.** From the top of the ranking, each issue is checked against the rules below until `limit` issues are attempted. A skipped issue does not use up the limit, so the next one takes its place. The plan job writes nothing to GitHub or Sentry. It uploads the plan as the `sentry-fix-plan` artifact and outputs only its SHA-256 and the id and short ID of each issue. The fix and publish jobs check that hash before they read the plan.
3. **Fix.** A matrix job runs the fixer on each attempted issue, two at a time, in a throwaway Docker container on the runner (see [Security](#security)). The fixer is `claude-opus-5-5` with a $10 budget per issue, on the Claude subscription only. The fixer edits the checkout and never commits.
4. **Verify.** When Claude answers `fixed`, the workflow starts a fresh container and runs each project command once itself. Its exit codes decide the gate. Claude's own report of its runs goes in the pull request body for reference only.
5. **Gate.** A pull request opens only when all of these hold:
    - Claude answered `fixed` at `high` or `medium` confidence.
    - Every project command ran in the workflow's own run and exited 0. A project without commands skips this.
    - The working tree has changes, and every changed tracked path is inside the project's `roots`. New untracked files outside the roots, such as a `TestResults` folder, are build output and are ignored.
    - No changed path is protected: `.github/`, `.claude/`, any `CLAUDE.md`, `AGENTS.md`, `REVIEW.md`, `review-policy.yml`, `CODEOWNERS`, `.npmrc`, `nuget.config`, or a lockfile.
    - No changed path is a build file that pull request CI would run before review: `package.json`, project, solution, `.props` and `.targets` files, `Directory.Build.*`, `global.json`, `.config/dotnet-tools.json`, a `Dockerfile`, a shell script, or a webpack, vite, jest, karma, eslint, babel, metro, tsconfig or app config.
    - Every change is a regular file, not a symlink or a submodule, and no file holds the Claude token.

    Anything else counts as no fix. A fixer that runs out of budget, turns or time also counts as no fix.
6. **Publish.** The `publish` job holds the bot and Sentry tokens and runs no repository code. For a fix, it commits the changes through the GitHub API as the bot app, points the branch `sentry-fix/<short id>` at the commit, and opens a ready pull request with the `sentry-autofix` label. Because the bot opens it, the repository's `pull_request` workflows (risk-tier, ai-review, CI) run on it. GitHub requests reviews from `CODEOWNERS`. Nobody is assigned. When the pull request is already open and someone else pushed to its branch, publish leaves the branch alone and refreshes only the body. For no fix, it posts the gate's reasons, the tail of each failed command and Claude's analysis as a Sentry note, and opens nothing.
7. **Merge.** The `sentry-fix-merged` action, on a closed pull request, adds `sentry-fix-merged` to a merged auto-fix pull request and posts a merged note.
8. **Release.** The `sentry-fix-release` action finds the merged `sentry-autofix` pull requests without `sentry-fix-released` whose merge commit is between the previous tag and this one. A missing `sentry-fix-merged` label does not matter. It resolves each issue whose project reports the app with `inRelease` set to the exact release name, and swaps the label to `sentry-fix-released`. It never resolves an issue at pull request time or with "next release". A pull request that fails, for example because its Sentry issue was deleted, is a warning, and the rest still resolve. The step fails only when every pull request in it failed.

Every step converges on a rerun. A rerun reuses the branch and the open pull request, and posts no note twice.

An infrastructure error leaves an issue with no note, so the next run tries it again. That covers a usage limit, a checkout at the wrong commit, a Docker or git error, and a run that changed `.git/config` or a `.gitattributes`.

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

Sentry event text is attacker-controlled, because the browser DSN is public and anyone can send an event. A prompt injection in that text could steer the fixer into running code it wrote, through a test file or a package script inside its roots and an allowed project command. The design assumes that can happen and limits what that code reaches.

- **Allowlisted context.** Only the issue title, the culprit, the thrown exception, up to 30 frames, the release, the platform, and the transaction path without its query string leave Sentry. Request data, user context, breadcrumbs, cookies, headers, frame variables, and the extra and context blobs never do, because they can hold student data.
- **Untrusted in the prompt.** The fixer gets the context inside `<untrusted_sentry_event>` and is told to treat it as data.
- **Separate jobs.** The fix job holds only the Claude OAuth token. It has no `id-token: write`, so no OIDC token can be minted in it. Its checkout keeps no credentials. The bot token and the Sentry token live in the publish job, which never runs repository code. Code in the fix job can rewrite its result, so the publish job takes the issue, the project and the base commit from the hashed plan, and checks the gate again against the config on the default branch.
- **Tools.** The fixer has `Read`, `Grep` and `Glob`, `Edit` and `Write` only under the project roots, and `Bash` for the project's exact commands. It has no git command and no web access.

### What the containers isolate

The fix job runs on the self-hosted `linux` pool. Those are persistent VMs that other jobs share, so the harness on the VM never runs the agent or a project command itself. It starts each in a throwaway container:

- The image is built from the `sentry-fix-run` [Dockerfile](../.github/actions/sentry-fix-run/Dockerfile): the .NET SDK image with Node.js from nodejs.org, checked against its published SHA-256. Its tag is a hash of the Dockerfile and the two versions, so the VM's layer cache serves later runs. The `fix-image` input replaces it.
- The agent session runs in one container, and the workflow's own run of the project commands in a second, fresh one without the Claude token.
- Each container mounts the checkout read-write at `/work`, its `.git` read-only on top, the harness and its Node.js read-only, and, for the session only, a per-issue directory for the request and the result.
- Each runs with `--cap-drop ALL`, `no-new-privileges`, the runner's uid, 2 CPUs, an 8 GB memory limit and a 4096 process limit. It shares no PID, network or IPC namespace with the VM, mounts no Docker socket, and is removed when it exits. It keeps the default bridge network, because Claude and package restores need the internet.
- Its env is the locale, `CI`, a few .NET switches, the names in the project's `env`, and for the session the Claude OAuth token. Each goes to `docker` by name, never with its value on the command line. Nothing that looks like a token, a key, a password, `GITHUB_*`, `ACTIONS_*`, `INPUT_*` or `RUNNER_*` gets through, even when the config lists it.

So code the fixer runs cannot see the harness process, the runner's env or files, other jobs on the VM, or the Docker daemon. It cannot write `.git`, so it cannot plant a hook or a filter there.

The harness's own git calls run with only `PATH` and `HOME`, no system or global config, and hooks and fsmonitor off. Before the session, the harness fingerprints `.git/config` and every `.gitattributes` git reads for a tracked file. If any changed, the result is failed and nothing is collected. It reads the changes with `git status --porcelain=v2` and direct reads of regular files, never through a symlink.

### What is left

- **The Claude OAuth token.** It is in the session container's env, because Claude needs it. Code the fixer runs in that container can read it from its own env or from the agent process, and send it out over the network. Claude Code can strip its credentials from the commands it runs, but only with bubblewrap, which cannot create namespaces inside this unprivileged container, so that switch is off. Rotate the token if a fixer run looks wrong, and keep it on an account used for nothing else.
- **The network.** The container can reach the internet and whatever the bridge network routes to, which includes the VMs' internal network.
- **A wrong fix.** A fix that passes the gate is still Claude's code. It opens as a normal pull request, and pull request CI runs on it with the repository's secrets before review. Build files are protected for that reason, but a test or source file inside the roots still runs in CI. Review it like any other pull request.

### Why there is no API fallback

The fixer runs on the Claude subscription only. A fallback to the Claude API through workload identity federation would need `id-token: write` on the fix job, and a federation token in the container that code there could read and spend. Instead, a usage limit leaves the issue with no note, and the next run tries it again. ai-review keeps its fallback, because it runs no repository code.

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
| `projects[].commands` | `[]` | Exact commands the fixer may run to build and test, from the repository root, inside the fixer's container. Write them so they need no `cd`, such as `npm --prefix client/web test`. The checkout has no dependencies installed, so list the install command too, such as `npm --prefix client/web ci`. The workflow runs every one of them again, in order, to verify a fix. |
| `projects[].env` | `[]` | Extra environment variable names the commands need, passed into the container with the runner's values. A path on the runner means nothing in the container, and `PATH` and `HOME` always come from the image. |
| `apps[].name` | | App name the release step passes. |
| `apps[].release` | | Sentry release name template with `{version}`, such as `OnCourse.Web@{version}`. |
| `apps[].projects` | | The project slugs that report this app's release. |

## Inputs

### `config-path`

**Optional** Path of the config, read from the default branch. **Default** `.github/sentry-fix.yml`

### `dry-run`

**Optional** `true` ranks, applies the rules and Jev triage, and prints the walk to the job summary: each issue, its event count, the decision and the reason. No fixer runs, and nothing is written to GitHub or Sentry. **Default** `false`

### `runs-on`

**Optional** Runner label for every job. The fix job needs Docker with buildx on it. **Default** `linux`

### `node-version`, `dotnet-version` and `global-json-file`

**Optional** The toolchain in the fixer's image. `node-version` is a Node.js major or exact version, **Default** `24`. `dotnet-version` is an `mcr.microsoft.com/dotnet/sdk` tag such as `10.0` or `10.0.100`, **Default** `10.0`. `global-json-file` is a path in the checkout. When it is set, its `sdk.version` picks the SDK image instead of `dotnet-version`. The harness itself always runs on Node.js 24.

### `fix-image`

**Optional** An image to run the fixer and the project commands in, instead of building one from the Dockerfile. It needs a glibc base, `bash`, and the toolchain the commands use. Its `HOME` must be writable by any uid.

### `sentry-org`

**Required** Sentry organization slug.

### `bot-client-id`

**Required** Client ID of the GitHub App that pushes the branches and opens the pull requests. In OnCourse repositories it is the org variable `GH_APP_CLIENT_ID`. The app needs `contents: write`, `pull-requests: write` and `issues: write`.

## Secrets

- `sentry-token`: a Sentry auth token with `project:read`, `event:read` and `event:write`.
- `typesafe-api-key`: TypeSafe API key for Jev.
- `claude-code-oauth-token`: Claude Code OAuth token the fixer runs on.
- `bot-app-private-key`: private key of the bot app.

## The merge and release actions

`sentry-fix-merged` takes `github-token`, `sentry-token` and `sentry-org`. Run it on `pull_request: closed`.

`sentry-fix-release` takes `github-token`, `sentry-token`, `sentry-org`, `app`, `tag`, `previous-tag`, and either `version` or `release`. With `version`, the release name is the app's template filled in. With `release`, the name is used as given. Mobile passes `release` after the store build, because only then does the version have its `+build` suffix. Run it after the release exists in Sentry, with `continue-on-error: true`, so a Sentry outage never blocks a release. The step output `release` is the name it used.

When two apps report the same Sentry project, the issue resolves in the release of whichever app ships the fix first, and the label moves to `sentry-fix-released` then.

## Run the dry run locally

```zsh
cd ai-review
npm ci
SENTRY_TOKEN=... TYPESAFE_API_KEY=... npm run sentry -- --dry-run --org <sentry org> --config ~/path/to/sentry-fix.yml --repo oncoursesystems/oncourse-systems
```

It reads `GH_TOKEN`, or `gh auth token`, for GitHub. It prints the walk table and writes nothing.
