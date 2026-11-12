# ai-labeler

The `ai-labeler` action is located at [.github/actions/ai-labeler/action.yml](/oncoursesystems/workflows/tree/main/.github/actions/ai-labeler/action.yml). Its source is the `ai-review` package, under [ai-review/src/labels](/oncoursesystems/workflows/tree/main/ai-review/src/labels).

The action labels a pull request with labels that each repository defines in a YAML file. For each label, the config holds the criteria for the label. The action asks Jev, TypeSafe's System One model, one yes or no question about the pull request for each label, and then adds or removes the label. A reviewer can filter and find pull requests by what they change, such as the AI features of an application.

## Features

- **Labels from your config**: Each repository lists its own labels and criteria. The action adds or removes only the labels in the config and never touches any other label.
- **One question per label**: Jev answers each question with the probability that the answer is yes. The `instructions` and `criteria` of a label are sent to Jev as written.
- **Thresholds that do not flap**: A label is added at `add_at` or above and removed below `remove_at`. Between the two, the label stays as it is, so a borderline pull request does not gain and lose a label on each push. Reruns on the same answers converge on the same labels.
- **Config from the default branch**: Reads the config from the default branch of the repository, never from the pull request, so a pull request cannot rewrite the criteria to label itself. A pull request stacked on another branch gets the same config as one that targets the default branch.
- **Creates missing labels**: A label that does not exist in the repository is created with the `color` and `description` from the config.
- **Drafts are labeled**: A draft pull request is labeled like any other.
- **Visible failures**: When Jev fails, the labels stay as they were and the step fails with the error. When the config is invalid, the step fails with every parse error. When the default branch has no config, the action logs it and succeeds without asking Jev.
- **Job summary**: Shows the model, the input tokens, whether Jev saw the whole diff, and a table of each label with its probability, thresholds, and action.
- **Backfill**: A `workflow_dispatch` run with the `pull-request` input labels a pull request that has no new event, such as one opened before the workflow existed, or any open pull request after the config changes. The comment at the top of the usage example has the loop that runs it for every open pull request.

## Inputs

### `github-token`

**Required** Token used to read the pull request and the config, and to create and set labels. The job needs the `contents: read`, `issues: write`, and `pull-requests: write` permissions.

### `typesafe-api-key`

**Required** TypeSafe API key for Jev.

### `pull-request`

**Optional** Number of the pull request to label. The action uses it only when the event is not a `pull_request` event, such as a `workflow_dispatch` backfill.

### `config-path`

**Optional** Path of the label config, read from the repository's default branch.

**Default** `.github/ai-labeler.yml`

### `jev-model`

**Optional** Jev model ID. Use a pinned version, not an alias such as `jev-latest`, because the thresholds are calibrated against one version.

**Default** `jev-1.14.0`

## Outputs

### `labels`

The labels from the config that are on the pull request after the run, comma-separated. Empty when none are.

## Usage

```yaml
name: ai-labeler

# This workflow never checks out the pull request. pull_request_target runs with write
# permissions, so the job must not run code from the pull request. The action reads the
# pull request through the API and reads its config from the default branch.
#
# Backfill: after the config changes, or to label pull requests opened before this
# workflow existed, run the workflow once for each open pull request:
#
#   gh pr list --state open --limit 500 --json number -q '.[].number' |
#     while read n; do gh workflow run ai-labeler.yml -f pull-request=$n; done
#
# Each run reads the config from the default branch and adds or removes
# only the labels the config lists.

on:
  pull_request_target:
    types: [opened, synchronize, reopened]
  workflow_dispatch:
    inputs:
      pull-request:
        description: Number of the pull request to label
        required: true
        type: number

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || inputs.pull-request }}
  cancel-in-progress: true

permissions:
  contents: read
  issues: write
  pull-requests: write

jobs:
  ai-labeler:
    runs-on: ubuntu-latest
    steps:
      - uses: oncoursesystems/workflows/.github/actions/ai-labeler@main
        with:
          github-token: ${{ github.token }}
          typesafe-api-key: ${{ secrets.TYPESAFE_AI_KEY }}
          pull-request: ${{ inputs.pull-request }}
```

The workflow uses `pull_request_target` so that pull requests from forks get a token that can set labels and can read the secret. For that reason the job must never check out or run code from the pull request. The action does not: it reads the pull request through the API.

## Config

Put `.github/ai-labeler.yml` on the default branch of the repository. Every key other than `labels` and `instructions` is optional. An unknown key makes the file invalid.

```yaml
labels:
  ai:
    color: 5319e7
    description: Adds or changes an AI feature of the application
    instructions:
      task: >-
        Does the pull request described by `pull_request`, `files`, and `diff` add or change an AI feature of the
        application? The known AI features are listed in `ai_features`.
      ai_features:
        - name: Message safety screening
          covers: Screens student posts with an AI model. Its code is named MessageSafety.
    criteria:
      true: The change alters the code, data, configuration, or tests of an AI feature, or adds a new one.
      false: No AI feature changes. Developer tooling and CI workflows that use AI do not count.
    add_at: 0.7
    remove_at: 0.3
```

`labels` is a map keyed by label name, with at least one entry. Label names are at most 50 characters and must differ by more than case, because GitHub treats `AI` and `ai` as one label.

| Key | Meaning |
| --- | --- |
| `color` | Six hex digits without `#`. Used only when the action creates the label. |
| `description` | Up to 100 characters. Used only when the action creates the label. |
| `instructions` | **Required** The question Jev answers with yes or no. A string, or a mapping that holds the question and the facts Jev needs, such as a list of known features. It is sent to Jev as written. It can name `pull_request`, `files`, and `diff`, which are the parts of the pull request that Jev reads. |
| `criteria` | Optional. `true` says what makes the answer yes and `false` says what makes it no. Both are required when `criteria` is present. Use it to settle the cases the instructions leave open. |
| `add_at` | Probability of yes at which the action adds the label. Default 0.7. |
| `remove_at` | Probability of yes below which the action removes the label. Default 0.3. Must be at most `add_at`. |

### Thresholds

Jev returns the probability that the answer to a question is yes. The action compares it with two thresholds for the label.

| Probability | Label is absent | Label is present |
| --- | --- | --- |
| `add_at` or more | Added | Unchanged |
| From `remove_at` up to below `add_at` | Unchanged | Unchanged |
| Below `remove_at` | Unchanged | Removed |

The band between the two thresholds is deliberate. A pull request that Jev is unsure about keeps the state it has, whether that is a label that a person added by hand or a label from an earlier push. Set both thresholds to the same value to remove the band. Calibrate the thresholds with the dry run below, because Jev's probabilities depend on how the question is worded.

Jev reads the title, the description, the author, the list of changed files, and as much of the diff as fits. Everything Jev reads for one question, the file list included, is kept to about 81,000 characters minus the size of the largest question, so a long `instructions` mapping leaves less room for the diff. When the diff does not fit, Jev sees as many whole files as fit and a `[diff truncated: N of M files shown]` marker. The job summary says when that happened.

## How It Works

1. **Collect**: Reads the pull request and up to 3000 changed files, and the config from the default branch.
2. **Ask Jev**: Sends one request to TypeSafe's Jev with the pull request and one `noul` question for each label. Rate limits (`429` and `529`) are retried three times. A request too long for the model is retried with a smaller diff, and then with a shorter file list. Any other error, or no answer within 60 seconds, counts as a Jev failure.
3. **Reconcile**: Compares each probability with the thresholds of its label and the labels already on the pull request.
4. **Publish**: Creates any missing labels, adds and removes the labels, sets the `labels` output, and writes the job summary.

## Dry run

The `ai-review` package has a command that asks Jev about a pull request and prints the answers without changing anything. It needs Node.js 22 or later.

```bash
cd ai-review
npm ci
GH_TOKEN=... TYPESAFE_API_KEY=... npm run labels -- example-org/example-repo#123 --dry-run
```

Pass a pull request URL instead of `owner/repo#number` if you prefer. Without `GH_TOKEN`, the command uses `gh auth token`. Pass `--config-file <path>` to try a local config instead of the one on the default branch, and `--jev-model <id>` to try another model. Without `--dry-run`, the command adds and removes the labels, just as the action does.

## Development

The bundle in `.github/actions/ai-labeler/dist` is committed, because callers run it directly. After a change under `ai-review`, run `npm run build` and commit the new bundles. The `ai-review-ci` workflow fails when a committed bundle differs from a fresh build.
