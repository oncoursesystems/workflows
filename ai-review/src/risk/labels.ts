import type { LabelChange, LabelSpec } from '../github/labels.ts';
import { TIERS, type Tier } from './tier.ts';

export const RISK_LABELS: Record<Tier, LabelSpec> = {
    low: { name: 'risk:low', color: '0e8a16', description: 'Risk tier: low' },
    medium: { name: 'risk:medium', color: 'fbca04', description: 'Risk tier: medium' },
    high: { name: 'risk:high', color: 'd93f0b', description: 'Risk tier: high' },
};

export const ALL_LABELS: readonly LabelSpec[] = TIERS.map((tier) => RISK_LABELS[tier]);

export function reconcileRiskLabels(current: readonly string[], tier: Tier): LabelChange {
    const wanted = RISK_LABELS[tier].name;
    const stale = TIERS.map((t) => RISK_LABELS[t].name).filter((name) => name !== wanted);
    return {
        add: current.includes(wanted) ? [] : [wanted],
        remove: current.filter((name) => stale.includes(name)),
    };
}
