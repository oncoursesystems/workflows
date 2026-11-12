import { describe, expect, it } from 'vitest';
import { hasLabel, missingLabels } from './labels.ts';

describe('missingLabels', () => {
    const specs = [
        { name: 'risk:low', color: '0e8a16' },
        { name: 'risk:high', color: 'd93f0b', description: 'Risk tier: high' },
    ];

    it('lists only the specs the repo lacks, with their color and description', () => {
        expect(missingLabels(['risk:low', 'bug'], specs)).toEqual([specs[1]]);
    });

    it('matches names the way GitHub does, ignoring case', () => {
        expect(missingLabels(['Risk:Low', 'RISK:HIGH'], specs)).toEqual([]);
    });
});

describe('hasLabel', () => {
    it('ignores case', () => {
        expect(hasLabel(['AI'], 'ai')).toBe(true);
        expect(hasLabel(['bug'], 'ai')).toBe(false);
    });
});
