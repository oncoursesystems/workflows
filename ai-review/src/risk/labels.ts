import { TIERS, type Tier } from './tier.ts';

export type LabelSpec = { name: string; color: string; description: string };

export const RISK_LABELS: Record<Tier, LabelSpec> = {
    low: { name: 'risk:low', color: '0e8a16', description: 'Risk tier: low' },
    medium: { name: 'risk:medium', color: 'fbca04', description: 'Risk tier: medium' },
    high: { name: 'risk:high', color: 'd93f0b', description: 'Risk tier: high' },
};

const FEEDBACK_COLOR = 'ededed';

export const FEEDBACK_LABELS: readonly LabelSpec[] = [
    { name: 'risk-ok', color: FEEDBACK_COLOR, description: 'The risk tier looks right' },
    ...TIERS.map((tier) => ({
        name: `risk-should-be:${tier}`,
        color: FEEDBACK_COLOR,
        description: `The risk tier should be ${tier}`,
    })),
];

export const ALL_LABELS: readonly LabelSpec[] = [...TIERS.map((tier) => RISK_LABELS[tier]), ...FEEDBACK_LABELS];

export type LabelChange = { add: string[]; remove: string[] };

export function reconcileRiskLabels(current: readonly string[], tier: Tier): LabelChange {
    const wanted = RISK_LABELS[tier].name;
    const stale = TIERS.map((t) => RISK_LABELS[t].name).filter((name) => name !== wanted);
    return {
        add: current.includes(wanted) ? [] : [wanted],
        remove: current.filter((name) => stale.includes(name)),
    };
}

export const missingLabels = (existing: readonly string[]): LabelSpec[] =>
    ALL_LABELS.filter((label) => !existing.includes(label.name));
