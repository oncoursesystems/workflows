# ai-review

The `ai-review` action is located at [.github/actions/ai-review/action.yml](/oncoursesystems/workflows/tree/main/.github/actions/ai-review/action.yml). Its source is the `ai-review` package, under [ai-review/src/review](/oncoursesystems/workflows/tree/main/ai-review/src/review).

The action reviews a pull request with Claude and posts the findings that survive an adversarial check. Its `ai-review` check always concludes `neutral`, so it blocks nothing.

## How a review runs

1. The pull request's `risk:` label picks the bug finders. Without a label the tier is medium.

    | Tier | Bug finders |
    | --- | --- |
    | Low | 1 `claude-sonnet-5-5` agent for correctness, contracts, and security together |
    | Medium | 3 `claude-sonnet-5-5` agents, one per kind |
    | High | 3 `claude-opus-5-5` agents, one per kind |

2. Each bug finder reads the diff, `CLAUDE.md` and `REVIEW.md` from the base branch, and the repository at the pull request head. It has only `Read`, `Grep`, `Glob`, and read-only `git` commands, and it returns candidates in a fixed JSON schema. It cannot post anything. A bug finder that answers without reading a file runs once more, with a note that tells it to read the changed files.
3. Candidates on the same file within 5 lines of each other merge, keeping the Important one. When 2 or more candidates remain, one `claude-sonnet-5-5` agent groups the ones that a single edit in one place would fix, and only the first of each group goes on. The same mistake in two methods stays as two candidates.
4. Three `claude-haiku-5-5` reviewers check each candidate in fresh contexts. Each gets the claim and the whole diff, with the candidate's file first, but not the bug finder's reasoning. A candidate survives when 2 of 3 say it is real. The reviewers also judge its severity against `REVIEW.md`: it is Important when at least half of the reviewers who confirmed it say so, and Minor otherwise.
5. The action, not Claude, posts the results:
    - When a run starts, the summary comment says the review is running. The action edits that same comment with the results, or with the error when the review fails.
    - Important findings on a line in the diff become review comments. A finding is never posted twice.
    - Important findings outside the diff, up to 3 Minor findings, and up to 2 pre-existing findings go in the summary comment, each with a link to its line. The heading over the Minor findings rotates per review, from `MINOR_HEADINGS` in `report.ts`, and stays the same for the same commit.
    - The `ai-review` check gets the same summary.
    - Each review comment asks the developer to react 👍 if the finding is a real problem or 👎 if it is wrong.
    - The run uploads a review record, a JSON artifact named `ai-review-<number>-round-<round>-<sha>`, kept for 90 days. It holds every candidate the reviewers saw, with their votes and reasons, where it was posted, and each agent's turns, tool calls, cost and time.

The summary comment keeps the reviewed commit and the round. A later push reviews only the changes since that commit. After 3 rounds the review stops.

## Inputs

### `github-token`

**Required** Workflow token. It posts the `ai-review` check, and the comments too when no bot app is given. The job needs the `contents: read`, `pull-requests: write`, `issues: write`, and `checks: write` permissions.

### `bot-app-id` and `bot-app-private-key`

**Optional** A GitHub App that posts the summary and the review comments, such as `oc-bot-ross`. Without them, the workflow token posts them as `github-actions[bot]`. The workflow token always posts the check.

### `claude-code-oauth-token`

**Required** Claude Code OAuth token the agents run on.

### `pull-request`

**Optional** Number of the pull request to review. The action uses it only when the event is not a `pull_request` event, such as a `workflow_dispatch` run.

## Usage

The job must check out the pull request head first, because the agents read the repository from the workspace. See `ai-review.yml` in oncourse-systems for the workflow that runs it on pull requests labeled `ai-review`.

## Run it locally

```zsh
cd ai-review
npm ci
npm run review -- --repo oncoursesystems/oncourse-systems --pr 2112 --dir ~/path/to/checkout-at-pr-head
```

The CLI prints the findings, the summary, and each agent's turns, tool calls, denied tool calls, cost and time. It posts nothing. Add `--publish` to post them. Claude runs on the local Claude Code login.

## Measure the reviews

Every review leaves enough behind to score it later. Collect the data before the review records expire, 90 days after each run.

### Where the data is

- **Review records.** One JSON artifact per run, described in `ReviewRecord` in [record.ts](/oncoursesystems/workflows/tree/main/ai-review/src/review/record.ts). List them with `gh api repos/<owner>/<repo>/actions/artifacts --paginate` and keep the names that start with `ai-review-`.
- **Review comments.** Each one hides `<!-- ai-review:finding <fingerprint> -->`. The same fingerprint is on the finding in the review record. Read the comments with `gh api repos/<owner>/<repo>/pulls/<number>/comments --paginate`, and their 👍 and 👎 counts in `reactions`.
- **Resolved threads.** The GraphQL `pullRequest.reviewThreads` field has `isResolved` for each thread.
- **Later commits.** `git log -L <line>,<line>:<file> <reviewedSha>..<merge commit>` shows whether the flagged line changed before the merge.
- **The pull requests.** Search for the `ai-review` label: `gh pr list --label ai-review --state all`.

### What to compute

- **Precision.** Of the review comments, the share marked 👍 and the share marked 👎. For comments with no reaction, use a changed line or a resolved thread as a weaker signal. Split by kind, tier and model.
- **Severity.** How often developers fix Important findings compared with Minor ones. If Minor findings get fixed as often, the Important bar in `REVIEW.md` is too high.
- **Reviewer filter.** Dropped candidates that turn out real, found in later fixes, show the reviewers dropping too much. Posted findings marked 👎 show them keeping too much.
- **Misses.** For bug-fix pull requests merged later, `git blame` the lines they fixed back to the pull request that added them. If that pull request had a review and no finding covered those lines, the review missed it.
- **Cost and time.** Per review, per tier and per agent, from the review records.
