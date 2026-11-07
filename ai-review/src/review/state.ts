import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Candidate } from './finding.ts';

export const SUMMARY_MARKER = '<!-- ai-review:summary -->';
export const MAX_ROUNDS = 3;

const ReviewState = z.object({ reviewedSha: z.string().min(1), round: z.number().int().positive() });
export type ReviewState = z.infer<typeof ReviewState>;

const STATE_PATTERN = /<!-- ai-review:state (\{.*?\}) -->/;

export function readState(summaryBody: string | undefined): ReviewState | undefined {
    const match = summaryBody?.match(STATE_PATTERN);
    if (match?.[1] === undefined) return undefined;
    try {
        const parsed = ReviewState.safeParse(JSON.parse(match[1]));
        return parsed.success ? parsed.data : undefined;
    } catch {
        return undefined;
    }
}

export const renderState = (state: ReviewState): string => `<!-- ai-review:state ${JSON.stringify(state)} -->`;

export function fingerprint(candidate: Pick<Candidate, 'file' | 'kind' | 'claim'>): string {
    const claim = candidate.claim.toLowerCase().replaceAll(/[^a-z0-9]+/g, ' ').trim().slice(0, 80);
    return createHash('sha256').update(`${candidate.file}\n${candidate.kind}\n${claim}`).digest('hex').slice(0, 16);
}

export const fingerprintMarker = (id: string): string => `<!-- ai-review:finding ${id} -->`;

export function fingerprintsIn(bodies: readonly string[]): Set<string> {
    const ids = new Set<string>();
    for (const body of bodies) {
        for (const match of body.matchAll(/<!-- ai-review:finding ([0-9a-f]{16}) -->/g)) {
            if (match[1] !== undefined) ids.add(match[1]);
        }
    }
    return ids;
}

export function rightSideLines(patch: string | undefined): Set<number> {
    const lines = new Set<number>();
    if (patch === undefined) return lines;
    let line = 0;
    for (const text of patch.split('\n')) {
        const hunk = text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunk?.[1] !== undefined) {
            line = Number(hunk[1]);
            continue;
        }
        if (text.startsWith('-') || text.startsWith('\\')) continue;
        lines.add(line);
        line++;
    }
    return lines;
}
