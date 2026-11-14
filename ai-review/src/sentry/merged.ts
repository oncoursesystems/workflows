import type { Octokit, RepoRef } from '../github/client.ts';
import { ensureLabels, hasLabel } from '../github/labels.ts';
import { hasNote, LABELS, markedIssueId } from './markers.ts';
import { mergedNote } from './report.ts';
import { listNotes, postNote, type SentryOptions } from './sentry.ts';

export type ClosedPr = { number: number; merged: boolean; labels: readonly string[]; body: string | null; url: string };

export type MergeOutcome = { kind: 'ignored'; reason: string } | { kind: 'marked'; issueId: string };

export async function onMerged(pr: ClosedPr, octokit: Octokit, repo: RepoRef, sentry: SentryOptions): Promise<MergeOutcome> {
    if (!pr.merged) return { kind: 'ignored', reason: 'it closed without merging' };
    if (!hasLabel(pr.labels, LABELS.autofix.name)) return { kind: 'ignored', reason: `it has no ${LABELS.autofix.name} label` };
    const issueId = markedIssueId(pr.body);
    if (issueId === undefined) return { kind: 'ignored', reason: 'its body has no sentry-issue marker' };
    await ensureLabels(octokit, repo, [LABELS.merged]);
    if (!hasLabel(pr.labels, LABELS.merged.name)) {
        await octokit.rest.issues.addLabels({ ...repo, issue_number: pr.number, labels: [LABELS.merged.name] });
    }
    if (!hasNote(await listNotes(sentry, issueId), { kind: 'merged', url: pr.url })) await postNote(sentry, issueId, mergedNote(pr.url));
    return { kind: 'marked', issueId };
}
