import { fetchBaseFile, type Octokit, type RepoRef } from '../github/client.ts';
import { applyLabelChange, ensureLabels, listLabelNames, type LabelChange } from '../github/labels.ts';
import type { PullRequest } from '../github/pull-request.ts';
import { askJev } from '../jev/ask.ts';
import type { DiffCoverage } from '../jev/state.ts';
import type { JevOptions } from '../jev/transport.ts';
import { lookupConfig, type ConfigLookup, type LabelRule } from './config.ts';
import { labelQuestions, parseLabelResponse } from './questions.ts';
import { changeOf, decideAll, managedLabelsAfter, type LabelDecision } from './reconcile.ts';

export async function fetchConfig(octokit: Octokit, repo: RepoRef, baseRef: string, path: string): Promise<ConfigLookup> {
    const file = await fetchBaseFile(octokit, repo, baseRef, path);
    switch (file.kind) {
        case 'missing':
            return { kind: 'missing', ref: baseRef };
        case 'unreadable':
            return { kind: 'invalid', ref: baseRef, error: file.error };
        case 'found':
            return lookupConfig(file.text, baseRef);
    }
}

export type LabelRun =
    | { status: 'failed'; error: string }
    | {
          status: 'answered';
          model: string;
          inputTokens: number;
          diff: DiffCoverage;
          decisions: LabelDecision[];
          change: LabelChange;
          labelsAfter: string[];
      };

export async function labelPullRequest(
    octokit: Octokit,
    repo: RepoRef,
    pr: PullRequest,
    rules: readonly LabelRule[],
    jev: JevOptions,
    dryRun: boolean,
): Promise<LabelRun> {
    const answer = await askJev(
        { pr, files: pr.files, questions: labelQuestions(rules), parse: parseLabelResponse(rules) },
        jev,
    );
    if (answer.status === 'failed') return answer;
    const { model, inputTokens, probabilities } = answer.value;
    const current = await listLabelNames(octokit, repo, pr.number);
    const decisions = decideAll(current, rules, probabilities);
    const change = changeOf(current, decisions);
    if (!dryRun) {
        await ensureLabels(octokit, repo, rules);
        await applyLabelChange(octokit, repo, pr.number, change);
    }
    return {
        status: 'answered',
        model,
        inputTokens,
        diff: answer.diff,
        decisions,
        change,
        labelsAfter: managedLabelsAfter(current, rules, decisions),
    };
}
