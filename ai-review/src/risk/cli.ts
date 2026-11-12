import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { getOctokit } from '@actions/github';
import { assess, type JevMode } from './assess.ts';
import { fetchPullRequest, parseRepo } from '../github/client.ts';
import { DEFAULT_JEV_MODEL } from '../jev/transport.ts';
import { DEFAULT_POLICY_PATH, fetchPolicy } from './github.ts';
import { lookupPolicy } from './policy.ts';
import { renderSummary } from './report.ts';

const USAGE = `Usage: npm run risk -- --repo <owner/repo> --pr <number> [options]

Classifies a pull request and prints the result. Posts nothing.

  --no-jev              classify on the policy and size rules alone
  --policy-file <path>  use a local policy file instead of the one on the base branch
  --policy-path <path>  policy path on the base branch (default ${DEFAULT_POLICY_PATH})
  --jev-model <id>      Jev model (default ${DEFAULT_JEV_MODEL})

Reads GH_TOKEN (or \`gh auth token\`) and TYPESAFE_API_KEY.`;

const { values } = parseArgs({
    options: {
        repo: { type: 'string' },
        pr: { type: 'string' },
        'no-jev': { type: 'boolean', default: false },
        'policy-file': { type: 'string' },
        'policy-path': { type: 'string', default: DEFAULT_POLICY_PATH },
        'jev-model': { type: 'string', default: DEFAULT_JEV_MODEL },
        help: { type: 'boolean', default: false },
    },
});

function fail(message: string): never {
    console.error(`${message}\n\n${USAGE}`);
    process.exit(2);
}

if (values.help) {
    console.log(USAGE);
    process.exit(0);
}
if (values.repo === undefined) fail('--repo is required.');
const number = Number(values.pr);
if (!Number.isInteger(number) || number <= 0) fail('--pr must be a pull request number.');

const githubToken = process.env['GH_TOKEN'] || execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
const apiKey = process.env['TYPESAFE_API_KEY'];
if (!values['no-jev'] && !apiKey) fail('TYPESAFE_API_KEY is not set. Set it, or pass --no-jev.');

const octokit = getOctokit(githubToken);
const repo = parseRepo(values.repo);
const pr = await fetchPullRequest(octokit, repo, number);
const lookup =
    values['policy-file'] === undefined
        ? await fetchPolicy(octokit, repo, pr.baseRef, values['policy-path'])
        : lookupPolicy(readFileSync(values['policy-file'], 'utf8'), values['policy-file']);
const mode: JevMode =
    values['no-jev'] || !apiKey ? { kind: 'skip' } : { kind: 'ask', options: { apiKey, model: values['jev-model'] } };

const classification = await assess(pr, lookup, mode);
console.log(JSON.stringify(classification, null, 2));
console.log(`\n${renderSummary(classification)}`);
