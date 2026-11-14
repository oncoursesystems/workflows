import { hasLabel } from '../github/labels.ts';
import { LABELS, type NoteMark } from './markers.ts';
import type { SentryIssue } from './sentry.ts';

export type AutoFixPr = { number: number; sentryIssueId: string; state: 'open' | 'merged' | 'closed'; labels: string[] };

export type SkipReason =
    | 'open-pr'
    | 'fix-pending-release'
    | 'rejected-pr'
    | 'released-fix'
    | 'prior-no-fix'
    | 'not-in-repo'
    | 'fixed-by-open-pr';

export type Decision = { kind: 'attempt' } | { kind: 'skip'; reason: SkipReason; detail: string };

export type IssueHistory = {
    autoPrs: readonly AutoFixPr[];
    mentioningOpenPrs: readonly number[];
    notes: readonly NoteMark[];
};

// Sentry raises these when an issue comes back after it was resolved, or suddenly grows. Either one earns a retry.
const RETRY_SUBSTATUSES = new Set(['regressed', 'escalating']);

const retryable = (issue: SentryIssue): boolean => issue.substatus !== null && RETRY_SUBSTATUSES.has(issue.substatus);

const numbers = (prs: readonly AutoFixPr[]): string => prs.map((pr) => `#${pr.number}`).join(', ');

type Rule = { reason: SkipReason; detail: (issue: SentryIssue, history: IssueHistory) => string | undefined };

const RULES: readonly Rule[] = [
    {
        reason: 'open-pr',
        detail: (_, { autoPrs, mentioningOpenPrs }) => {
            const open = [...new Set([...autoPrs.filter((pr) => pr.state === 'open').map((pr) => pr.number), ...mentioningOpenPrs])];
            return open.length > 0 ? `open pull request ${open.map((n) => `#${n}`).join(', ')}` : undefined;
        },
    },
    {
        reason: 'fix-pending-release',
        detail: (_, { autoPrs }) => {
            const pending = autoPrs.filter((pr) => pr.state === 'merged' && !hasLabel(pr.labels, LABELS.released.name));
            return pending.length > 0 ? `${numbers(pending)} merged and waits for a release` : undefined;
        },
    },
    {
        reason: 'released-fix',
        detail: (issue, { autoPrs }) => {
            const released = autoPrs.filter((pr) => pr.state === 'merged' && hasLabel(pr.labels, LABELS.released.name));
            return released.length > 0 && !retryable(issue) ? `${numbers(released)} shipped, and the issue has not regressed` : undefined;
        },
    },
    {
        reason: 'rejected-pr',
        detail: (issue, { autoPrs }) => {
            const rejected = autoPrs.filter((pr) => pr.state === 'closed');
            return rejected.length > 0 && !retryable(issue) ? `${numbers(rejected)} closed without merging` : undefined;
        },
    },
    {
        reason: 'prior-no-fix',
        detail: (issue, { notes }) => {
            const noFix = notes.flatMap((note) => (note.kind === 'no-fix' ? [note.date] : []));
            return noFix.length > 0 && !retryable(issue) ? `no confident fix on ${noFix.join(', ')}` : undefined;
        },
    },
];

export function decide(issue: SentryIssue, history: IssueHistory): Decision {
    for (const rule of RULES) {
        const detail = rule.detail(issue, history);
        if (detail !== undefined) return { kind: 'skip', reason: rule.reason, detail };
    }
    return { kind: 'attempt' };
}
