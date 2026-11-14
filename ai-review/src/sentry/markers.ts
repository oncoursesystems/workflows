export const LABELS = {
    autofix: { name: 'sentry-autofix', color: 'd73a4a', description: 'Opened by sentry-fix for a production Sentry issue' },
    merged: { name: 'sentry-fix-merged', color: 'fbca04', description: 'A sentry-fix pull request that waits for a release' },
    released: { name: 'sentry-fix-released', color: '0e8a16', description: 'A sentry-fix pull request that shipped in a release' },
} as const;

export const issueMarker = (issueId: string): string => `<!-- sentry-issue: ${issueId} -->`;

const ISSUE_MARKER = /<!-- sentry-issue: (\d+) -->/;

export const markedIssueId = (body: string | null | undefined): string | undefined => ISSUE_MARKER.exec(body ?? '')?.[1];

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A short ID such as ONCOURSE-WEB-3K must not match inside ONCOURSE-WEB-3K7.
export const mentionsShortId = (text: string, shortId: string): boolean =>
    new RegExp(`(?<![A-Za-z0-9-])${escapeRegExp(shortId)}(?![A-Za-z0-9])`, 'i').test(text);

export const NOTE_PREFIX = '[sentry-fix]';

export type NoteMark = { kind: 'pr'; url: string } | { kind: 'no-fix'; date: string } | { kind: 'merged'; url: string };

export function renderNoteMark(mark: NoteMark): string {
    switch (mark.kind) {
        case 'pr':
            return `${NOTE_PREFIX} pr ${mark.url}`;
        case 'no-fix':
            return `${NOTE_PREFIX} no-fix ${mark.date}`;
        case 'merged':
            return `${NOTE_PREFIX} merged ${mark.url}`;
    }
}

const NOTE_MARK = /^\[sentry-fix\] (pr|no-fix|merged) (\S+)\s*$/;

export function parseNoteMark(note: string): NoteMark | undefined {
    const match = NOTE_MARK.exec(note.split('\n', 1)[0] ?? '');
    const [, kind, value = ''] = match ?? [];
    if (kind === 'no-fix') return { kind, date: value };
    if (kind === 'pr' || kind === 'merged') return { kind, url: value };
    return undefined;
}

export const hasNote = (notes: readonly string[], mark: NoteMark): boolean => {
    const line = renderNoteMark(mark);
    return notes.some((note) => note.split('\n', 1)[0]?.trim() === line);
};

export const noteDate = (now: Date): string => now.toISOString().slice(0, 10);
