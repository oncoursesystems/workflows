import type { Octokit, RepoRef } from '../github/client.ts';
import { applyLabelChange, ensureLabels, hasLabel } from '../github/labels.ts';
import { appOf, renderRelease, type AppConfig, type SentryFixConfig } from './config.ts';
import { labelNames } from './github.ts';
import { LABELS, markedIssueId, markerMatchesBranch } from './markers.ts';
import { fetchIssue, resolveInRelease, type SentryOptions } from './sentry.ts';

export type ReleaseInput = { app: string; version: string; release: string; tag: string; previousTag: string };

const COMPARE_PAGE = 100;

// Mobile builds get a +build suffix only once the store build exists, so the caller may pass the whole name instead.
export function releaseName(config: SentryFixConfig, input: Pick<ReleaseInput, 'app' | 'version' | 'release'>): string {
    const app = appOf(config, input.app);
    if (app === undefined) throw new Error(`the config has no app named ${input.app}`);
    if (input.release !== '') return input.release;
    if (input.version === '') throw new Error('give the version or the full release name');
    return renderRelease(app, input.version);
}

export async function commitsBetween(octokit: Octokit, repo: RepoRef, previousTag: string, tag: string): Promise<Set<string>> {
    const shas = new Set<string>();
    for (let page = 1; ; page++) {
        const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
            ...repo,
            basehead: `${previousTag}...${tag}`,
            per_page: COMPARE_PAGE,
            page,
        });
        for (const commit of data.commits) shas.add(commit.sha);
        if (data.commits.length < COMPARE_PAGE) return shas;
    }
}

export type MergedFix = { number: number; mergeCommitSha: string | null; issueId: string; headRef: string };

export const fixesInRange = (fixes: readonly MergedFix[], shas: ReadonlySet<string>): MergedFix[] =>
    fixes.filter((fix) => fix.mergeCommitSha !== null && shas.has(fix.mergeCommitSha));

// The merged label is only a marker for people. A merge hook that never ran must not leave a fix unreleased.
async function mergedFixes(octokit: Octokit, repo: RepoRef): Promise<MergedFix[]> {
    const items = await octokit.paginate(octokit.rest.issues.listForRepo, { ...repo, labels: LABELS.autofix.name, state: 'closed', per_page: 100 });
    const fixes: MergedFix[] = [];
    for (const item of items) {
        const issueId = markedIssueId(item.body);
        if (!item.pull_request?.merged_at || issueId === undefined) continue;
        if (hasLabel(labelNames(item.labels), LABELS.released.name)) continue;
        const { data: pr } = await octokit.rest.pulls.get({ ...repo, pull_number: item.number });
        fixes.push({ number: item.number, mergeCommitSha: pr.merged ? pr.merge_commit_sha : null, issueId, headRef: pr.head.ref });
    }
    return fixes;
}

export type ResolveStatus = 'resolved' | 'skipped' | 'mismatch' | 'failed';

export type ResolveOutcome = { number: number; issueId: string; shortId: string | null; status: ResolveStatus; reason: string };

export type ResolveOptions = { octokit: Octokit; repo: RepoRef; sentry: SentryOptions; config: SentryFixConfig; input: ReleaseInput };

async function resolveFix(options: ResolveOptions, app: AppConfig, release: string, fix: MergedFix): Promise<ResolveOutcome> {
    const { octokit, repo, sentry } = options;
    const issue = await fetchIssue(sentry, fix.issueId);
    const outcome = { number: fix.number, issueId: fix.issueId, shortId: issue.shortId };
    if (!markerMatchesBranch(fix.headRef, issue.shortId)) {
        return { ...outcome, status: 'mismatch', reason: `skipped, because its marker names ${issue.shortId} but its branch is ${fix.headRef}` };
    }
    if (!app.projects.includes(issue.project)) return { ...outcome, status: 'skipped', reason: `${issue.project} does not report ${app.name}` };
    await resolveInRelease(sentry, fix.issueId, release);
    await applyLabelChange(octokit, repo, fix.number, { add: [LABELS.released.name], remove: [LABELS.merged.name] });
    return { ...outcome, status: 'resolved', reason: `resolved in ${release}` };
}

// One deleted issue or a Sentry outage must not cost the other fixes in the release their resolve.
export async function resolveRelease(options: ResolveOptions): Promise<{ release: string; outcomes: ResolveOutcome[] }> {
    const { octokit, repo, config, input } = options;
    const release = releaseName(config, input);
    const app = appOf(config, input.app)!;
    const shipped = fixesInRange(await mergedFixes(octokit, repo), await commitsBetween(octokit, repo, input.previousTag, input.tag));
    const outcomes: ResolveOutcome[] = [];
    if (shipped.length > 0) await ensureLabels(octokit, repo, [LABELS.released]);
    for (const fix of shipped) {
        try {
            outcomes.push(await resolveFix(options, app, release, fix));
        } catch (error) {
            const reason = `failed: ${error instanceof Error ? error.message : String(error)}`;
            outcomes.push({ number: fix.number, issueId: fix.issueId, shortId: null, status: 'failed', reason });
        }
    }
    return { release, outcomes };
}

export const allFailed = (outcomes: readonly ResolveOutcome[]): boolean =>
    outcomes.length > 0 && outcomes.every((outcome) => outcome.status === 'failed');
