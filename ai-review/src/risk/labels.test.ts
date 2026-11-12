import { describe, expect, it } from 'vitest';
import { reconcileRiskLabels } from './labels.ts';

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
