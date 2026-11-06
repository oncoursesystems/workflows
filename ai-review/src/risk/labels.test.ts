import { describe, expect, it } from 'vitest';
import { missingLabels, reconcileRiskLabels } from './labels.ts';

describe('reconcileRiskLabels', () => {
    it('swaps a stale tier label for the new one', () => {
        expect(reconcileRiskLabels(['risk:high', 'bug'], 'medium')).toEqual({ add: ['risk:medium'], remove: ['risk:high'] });
    });

    it('changes nothing when the right label is already the only one', () => {
        expect(reconcileRiskLabels(['risk:low', 'bug'], 'low')).toEqual({ add: [], remove: [] });
    });

    it('removes every other tier label', () => {
        expect(reconcileRiskLabels(['risk:low', 'risk:medium', 'risk:high'], 'high')).toEqual({
            add: [],
            remove: ['risk:low', 'risk:medium'],
        });
    });

    it('leaves other labels alone', () => {
        expect(reconcileRiskLabels(['bug', 'needs-human-review'], 'medium')).toEqual({ add: ['risk:medium'], remove: [] });
    });
});

describe('missingLabels', () => {
    it('lists only the labels the repo lacks, with their colors', () => {
        const missing = missingLabels(['risk:low', 'risk:medium', 'bug']);
        expect(missing).toEqual([{ name: 'risk:high', color: 'd93f0b', description: 'Risk tier: high' }]);
    });
});
