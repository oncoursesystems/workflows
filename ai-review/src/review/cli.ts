import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { getOctokit } from '@actions/github';
import { parsePullRequestNumber, parseRepo } from '../risk/github.ts';
import { runAgent } from './agent.ts';
import { renderAgentLog } from './report.ts';
import { runReview } from './run.ts';

const USAGE = `Usage: npm run review -- --repo <owner/repo> --pr <number> --dir <checkout> [--publish] [--continue]

Reviews a pull request with the tier's bug finders and adversarial reviewers, and prints the summary.

  --dir       a checkout of the repository at the pull request head, which the agents read
  --publish   post the summary, the inline comments and the ai-review check to the pull request
  --continue  review only the changes since the last published review, instead of the whole pull request

Reads GH_TOKEN (or \`gh auth token\`). Claude runs on the local Claude Code login, or CLAUDE_CODE_OAUTH_TOKEN.`;

const { values } = parseArgs({
    options: {
        repo: { type: 'string' },
        pr: { type: 'string' },
        dir: { type: 'string' },
        publish: { type: 'boolean', default: false },
        continue: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
    },
});

if (values.help || values.repo === undefined || values.pr === undefined || values.dir === undefined) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 2);
}

const githubToken = process.env['GH_TOKEN'] || execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
const octokit = getOctokit(githubToken);
const outcome = await runReview({
    octokit,
    checksOctokit: octokit,
    repo: parseRepo(values.repo),
    number: parsePullRequestNumber(values.pr),
    cwd: values.dir,
    fresh: !values.continue,
    awaitRiskTier: false,
    publish: values.publish,
    runAgent,
});

if (outcome.kind !== 'reviewed') {
    console.log(JSON.stringify(outcome, null, 2));
} else {
    console.log(JSON.stringify(outcome.result.findings, null, 2));
    console.log(`\n${outcome.summary}`);
    console.log(`\n${renderAgentLog(outcome.result.agents)}`);
}
