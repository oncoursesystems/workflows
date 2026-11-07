# risk-tier

The `risk-tier` action is located at [.github/actions/risk-tier/action.yml](/oncoursesystems/workflows/tree/main/.github/actions/risk-tier/action.yml). Its source is the `ai-review` package, under [ai-review/src/risk](/oncoursesystems/workflows/tree/main/ai-review/src/risk).

The action classifies each pull request as low, medium, or high risk and publishes the tier. A reviewer can see at a glance how much human attention a change needs. The action blocks nothing. Its check always concludes `neutral`.

## Features

- **Risk label**: Sets exactly one of `risk:low`, `risk:medium`, or `risk:high` on the pull request and removes the other two. Reruns converge on the same labels.
- **Check run**: Creates a `risk-tier` check on the head commit. Its summary lists the tier, every reason that raised it, Jev's probabilities, the model, the input tokens, and whether the diff was cut to fit the model. The job summary shows the same text.
- **Policy from the base branch**: Reads `review-policy.yml` from the base branch, never from the pull request, so a pull request cannot lower its own tier.
- **Fails to a person**: When Jev fails, or the policy file is invalid, the tier is at least medium.
- **Drafts are skipped**: A draft pull request is not classified. Mark it ready for review to classify it.
- **Backfill**: A `workflow_dispatch` run with the `pull-request` input classifies a pull request that has no new event, such as one opened before the workflow existed or one whose base branch changed its review policy. The comment at the top of the usage example has the loop that runs it for every open pull request.

## Inputs

### `github-token`

**Required** Token used to read the pull request and the policy, set labels, and create the check run. The job needs the `contents: read`, `pull-requests: write`, `issues: write`, and `checks: write` permissions.

### `typesafe-api-key`

**Required** TypeSafe API key for Jev.

### `pull-request`

**Optional** Number of the pull request to classify. The action uses it only when the event is not a `pull_request` event, such as a `workflow_dispatch` backfill.

### `policy-path`

**Optional** Path of the review policy, read from the pull request's base branch.

**Default** `review-policy.yml`

### `jev-model`

**Optional** Jev model ID. Use a pinned version, not an alias such as `jev-latest`, because the flag thresholds are tuned against one version.

**Default** `jev-1.14.0`

## Outputs

### `tier`

The risk tier, `low`, `medium`, or `high`. Empty for a draft pull request.

## Usage

```yaml
name: risk-tier

# Backfill: after a review-policy.yml change merges, or to classify pull requests opened
# before this workflow existed, run the workflow once for each open pull request that is
# not a draft:
#
#   gh pr list --state open --limit 500 --json number,isDraft -q '.[] | select(.isDraft | not) | .number' |
#     while read n; do gh workflow run risk-tier.yml -f pull-request=$n; done
#
# Each run reads review-policy.yml from the pull request's base branch, replaces its risk
# label, and adds a new risk-tier check. The action skips drafts.

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  workflow_dispatch:
    inputs:
      pull-request:
        description: Number of the pull request to classify
        required: true
        type: number

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || inputs.pull-request }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: write
  issues: write
  checks: write

jobs:
  risk-tier:
    if: ${{ !github.event.pull_request.draft }}
    runs-on: ubuntu-latest
    steps:
      - uses: oncoursesystems/workflows/.github/actions/risk-tier@main
        with:
          github-token: ${{ github.token }}
          typesafe-api-key: ${{ secrets.TYPESAFE_AI_KEY }}
          pull-request: ${{ inputs.pull-request }}
```

## Review policy

Put `review-policy.yml` at the root of the repository. Every key is optional. An unknown key makes the file invalid.

```yaml
minimum_risk:
  high: [ "src/Auth/**", ".github/workflows/**", "review-policy.yml" ]
  medium: [ "src/Data/**", "**/*.config" ]
low_max_changed_lines: 400
ignore: [ "**/ext/**", "**/bootstrap.json", "**/package-lock.json" ]
sensitive_areas:
  - name: Grades and transcripts
    covers: grades, GPAs, transcripts and assessment scores (gradebook)
trusted_team: example-org/trusted-authors
policy_admins: example-org/policy-admins
```

| Key | Meaning |
| --- | --- |
| `minimum_risk` | Glob lists per tier. A changed file whose path, or whose path before a rename, matches a glob raises the tier to at least that level. Globs match dot directories such as `.github`. |
| `low_max_changed_lines` | A pull request with more changed lines than this is at least medium. Defaults to 400. |
| `ignore` | Globs for files that do not count toward the changed lines and are not sent to Jev. Ignored files still count for `minimum_risk`. |
| `sensitive_areas` | Areas where a mistake is costly or cannot be undone. Each entry has a `name` and a `covers` description that names the data and the modules. Jev is asked whether the change alters how any of them is calculated, saved, deleted, or sent. A yes makes the pull request at least medium, even behind a feature flag. When the list is empty, Jev is not asked. |
| `trusted_team` | Reserved for a later phase. |
| `policy_admins` | Reserved for a later phase. |

List `review-policy.yml` itself under `high`, so a change to the policy gets careful review. Without a policy file, the action uses an empty policy with the 400-line default and says so in the check.

## How It Works

1. **Collect**: Reads the pull request and up to 3000 changed files, and the policy from the base branch.
2. **Ask Jev**: Sends one request to TypeSafe's Jev with the title, body, author, the list of files that are not ignored, and their diff. Everything Jev reads, the file list included, is kept to about 80,000 characters, which fits Jev's 32,000-token context for one question. When the diff does not fit, it holds as many whole files as fit and ends with a `[diff truncated: N of M files shown]` marker. Jev answers up to three questions at once: the tier, the probability that the change alters who can see or change which records, and, when the policy lists `sensitive_areas`, the probability that the change alters one of them. Rate limits (`429` and `529`) are retried three times. A request too long for the model is retried once without the diff. Any other error, or no answer within 60 seconds, counts as a Jev failure.
3. **Classify**: Each rule gives reasons, and the tier is the highest reason, starting from low.

| Rule | Raises the tier to |
| --- | --- |
| A changed file matches a `minimum_risk` glob | That glob's tier |
| More changed lines than `low_max_changed_lines`, outside ignored files | Medium |
| Jev's chosen tier | Jev's tier |
| Access change probability of 0.5 or more | High |
| Sensitive area probability of 0.5 or more | Medium |
| Jev failed | Medium |
| The policy file is invalid | Medium |

4. **Publish**: Sets the risk label, creates any missing labels, creates the `risk-tier` check, and writes the job summary.

## Dry run

The `ai-review` package has a command that classifies a pull request and prints the result without posting anything. It needs Node.js 22 or later.

```bash
cd ai-review
npm ci
GH_TOKEN=... TYPESAFE_API_KEY=... npm run risk -- --repo example-org/example-repo --pr 123
```

Without `GH_TOKEN`, the command uses `gh auth token`. Pass `--no-jev` to classify on the policy and size alone, or `--policy-file <path>` to try a local policy instead of the one on the base branch.

## Development

The bundle in `.github/actions/risk-tier/dist` is committed, because callers run it directly. After a change under `ai-review`, run `npm run build` and commit the new bundle. The `ai-review-ci` workflow fails when the committed bundle differs from a fresh build.
