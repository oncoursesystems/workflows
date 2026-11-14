import { describe, expect, it } from 'vitest';
import { decodePlan, encodePlan, plannedIssue, sha256, type PlannedIssue } from './handoff.ts';
import { issueContextOf, sentryIssue } from './testing.ts';

const planned = (id: string, message: string): PlannedIssue => ({
    sha: 'a'.repeat(40),
    period: '7d',
    project: { slug: 'p', description: 'd', roots: ['src'], commands: [], env: [] },
    context: issueContextOf(sentryIssue({ id, shortId: `S-${id}` }), {
        message,
        frames: Array.from({ length: 30 }, (_, i) => ({ file: `src/${'漢'.repeat(200)}${i}.js`, module: null, fn: 'fn', line: i, inApp: true })),
    }),
});

describe('the plan handoff', () => {
    const plan = [planned('1', `TypeError: ${'錯誤'.repeat(20_000)}`), planned('2', 'RangeError 🙂')];

    it('round-trips a plan of any size and script through its bytes and hash', () => {
        const { bytes, sha256, keys } = encodePlan(plan);
        expect(bytes.length).toBeGreaterThan(131_072);
        expect(keys).toEqual([
            { id: '1', shortId: 'S-1' },
            { id: '2', shortId: 'S-2' },
        ]);
        expect(decodePlan(bytes, sha256)).toEqual(plan);
        expect(decodePlan(bytes, sha256.toUpperCase())).toEqual(plan);
    });

    it('rejects a file whose bytes changed, even by one byte inside a multi-byte character', () => {
        const { bytes, sha256 } = encodePlan(plan);
        const tampered = Buffer.from(bytes);
        const at = tampered.indexOf(Buffer.from('錯', 'utf8'));
        tampered[at + 2] = tampered[at + 2]! ^ 1;
        expect(() => decodePlan(tampered, sha256)).toThrow(/^the plan file has SHA-256 [0-9a-f]{64}, but the plan job wrote/);
    });

    it('rejects a file that matches its hash but is not a plan', () => {
        const bytes = Buffer.from('{"issues":[]}');
        expect(() => decodePlan(bytes, sha256(bytes))).toThrow('the plan file is not valid');
    });

    it('finds a planned issue by its id, and fails for one the plan does not have', () => {
        expect(plannedIssue(plan, '2').context.message).toBe('RangeError 🙂');
        expect(() => plannedIssue(plan, '3')).toThrow('the plan has no issue 3');
    });
});
