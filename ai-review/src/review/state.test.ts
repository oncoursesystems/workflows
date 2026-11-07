import { describe, expect, it } from 'vitest';
import { fingerprint, fingerprintMarker, fingerprintsIn, readState, renderState, rightSideLines } from './state.ts';

describe('review state', () => {
    it('reads back the state it renders inside a summary', () => {
        const state = { reviewedSha: 'abc123def', round: 2 };
        expect(readState(`## AI review\n\ntext\n${renderState(state)}`)).toEqual(state);
    });

    it('reads no state from a missing, foreign or corrupt summary', () => {
        expect(readState(undefined)).toBeUndefined();
        expect(readState('a human comment')).toBeUndefined();
        expect(readState('<!-- ai-review:state {"reviewedSha":"x","round":0} -->')).toBeUndefined();
        expect(readState('<!-- ai-review:state {not json} -->')).toBeUndefined();
    });
});

describe('fingerprint', () => {
    it('ignores case and punctuation in the claim but not the file', () => {
        const base = { file: 'a.cs', kind: 'correctness' as const, claim: 'Missed null check on school!' };
        expect(fingerprint({ ...base, claim: 'missed NULL check, on school' })).toBe(fingerprint(base));
        expect(fingerprint({ ...base, file: 'b.cs' })).not.toBe(fingerprint(base));
    });

    it('finds the fingerprints posted in earlier comments', () => {
        const id = fingerprint({ file: 'a.cs', kind: 'security', claim: 'x' });
        expect(fingerprintsIn([`body\n${fingerprintMarker(id)}`, 'a human reply'])).toEqual(new Set([id]));
    });
});

describe('rightSideLines', () => {
    it('lists the new-file lines a review comment can attach to', () => {
        const patch = ['@@ -10,3 +10,4 @@ class Notes', ' keep', '-old', '+new one', '+new two', ' keep', '@@ -40 +41 @@', '+tail'].join('\n');
        expect([...rightSideLines(patch)]).toEqual([10, 11, 12, 13, 41]);
    });

    it('has no lines for a file without a patch', () => {
        expect(rightSideLines(undefined).size).toBe(0);
    });
});
