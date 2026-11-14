export const LABELS = {
    autofix: { name: 'sentry-autofix', color: 'd73a4a', description: 'Opened by sentry-fix for a production Sentry issue' },
    merged: { name: 'sentry-fix-merged', color: 'fbca04', description: 'A sentry-fix pull request that waits for a release' },
    released: { name: 'sentry-fix-released', color: '0e8a16', description: 'A sentry-fix pull request that shipped in a release' },
    mismatch: { name: 'sentry-fix-mismatch', color: 'b60205', description: 'A sentry-fix pull request whose marker and branch disagree, so no release resolves it' },
} as const;

export const branchName = (shortId: string): string => `sentry-fix/${shortId.toLowerCase()}`;

// The marker and the branch are written together by publish, so a pull request whose two disagree was edited by hand
// or carries a forged marker.
export const markerMatchesBranch = (headRef: string, shortId: string): boolean => headRef === branchName(shortId);

export const issueMarker = (issueId: string): string => `<!-- sentry-issue: ${issueId} -->`;

const ISSUE_MARKER = /^<!-- sentry-issue: (\d+) -->$/;

export const commitMarker = (sha: string): string => `<!-- sentry-fix-commit: ${sha} -->`;

const COMMIT_MARKER = /^<!-- sentry-fix-commit: ([0-9a-f]{40}) -->$/;

const bodyLines = (body: string | null | undefined): string[] =>
    (body ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '');

// Sentry and agent text in the body come before the marker, so only the last line counts.
export const markedIssueId = (body: string | null | undefined): string | undefined => ISSUE_MARKER.exec(bodyLines(body).at(-1) ?? '')?.[1];

// The commit publish last pointed the branch at, on the line directly above the issue marker.
export const markedCommit = (body: string | null | undefined): string | undefined => {
    const lines = bodyLines(body);
    if (!ISSUE_MARKER.test(lines.at(-1) ?? '')) return undefined;
    return COMMIT_MARKER.exec(lines.at(-2) ?? '')?.[1];
};

// A zero-width joiner keeps untrusted text from opening an HTML comment, so it cannot plant or hide a marker.
export const defang = (text: string): string => text.replaceAll('<!--', '<!-\u200d-');

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A short ID such as ONCOURSE-WEB-3K must not match inside ONCOURSE-WEB-3K7.
export const mentionsShortId = (text: string, shortId: string): boolean =>
    new RegExp(`(?<![A-Za-z0-9-])${escapeRegExp(shortId)}(?![A-Za-z0-9])`, 'i').test(text);

export const NOTE_PREFIX = '[sentry-fix]';

// A no-fix note names the workflow run that posted it, so a rerun of that run on another day posts no second note.
// Notes from before the run id have none.
export type NoteMark = { kind: 'pr'; url: string } | { kind: 'no-fix'; date: string; run?: string } | { kind: 'merged'; url: string };

export function renderNoteMark(mark: NoteMark): string {
    switch (mark.kind) {
        case 'pr':
            return `${NOTE_PREFIX} pr ${mark.url}`;
        case 'no-fix':
            return `${NOTE_PREFIX} no-fix ${mark.date}${mark.run === undefined ? '' : ` run ${mark.run}`}`;
        case 'merged':
            return `${NOTE_PREFIX} merged ${mark.url}`;
    }
}

const NOTE_MARK = /^\[sentry-fix\] (?:(pr|merged) (\S+)|no-fix (\S+)(?: run (\d+))?)\s*$/;

export function parseNoteMark(note: string): NoteMark | undefined {
    const match = NOTE_MARK.exec(note.split('\n', 1)[0] ?? '');
    if (match === null) return undefined;
    const [, kind, url = '', date = '', run] = match;
    if (kind === 'pr' || kind === 'merged') return { kind, url };
    return run === undefined ? { kind: 'no-fix', date } : { kind: 'no-fix', date, run };
}

const sameNote = (found: NoteMark, wanted: NoteMark): boolean => {
    if (found.kind === 'no-fix' && wanted.kind === 'no-fix') {
        return wanted.run === undefined ? found.date === wanted.date && found.run === undefined : found.run === wanted.run;
    }
    if (found.kind === 'no-fix' || wanted.kind === 'no-fix') return false;
    return found.kind === wanted.kind && found.url === wanted.url;
};

export const hasNote = (notes: readonly string[], mark: NoteMark): boolean =>
    notes.some((note) => {
        const found = parseNoteMark(note);
        return found !== undefined && sameNote(found, mark);
    });

export const noteDate = (now: Date): string => now.toISOString().slice(0, 10);
