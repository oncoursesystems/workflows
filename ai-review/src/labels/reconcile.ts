import { hasLabel, type LabelChange } from '../github/labels.ts';
import type { LabelRule } from './config.ts';

export type LabelAction = 'added' | 'removed' | 'kept' | 'unchanged';

export type LabelDecision = { rule: LabelRule; probability: number; action: LabelAction };

export function decide(rule: LabelRule, present: boolean, probability: number): LabelAction {
    if (probability >= rule.addAt) return present ? 'unchanged' : 'added';
    if (probability < rule.removeAt) return present ? 'removed' : 'unchanged';
    return 'kept';
}

export const decideAll = (
    current: readonly string[],
    rules: readonly LabelRule[],
    probabilities: ReadonlyMap<string, number>,
): LabelDecision[] =>
    rules.map((rule) => {
        const probability = probabilities.get(rule.name);
        if (probability === undefined) throw new Error(`no answer for label "${rule.name}"`);
        return { rule, probability, action: decide(rule, hasLabel(current, rule.name), probability) };
    });

export const changeOf = (current: readonly string[], decisions: readonly LabelDecision[]): LabelChange => ({
    add: decisions.filter((d) => d.action === 'added').map((d) => d.rule.name),
    remove: decisions
        .filter((d) => d.action === 'removed')
        .map((d) => current.find((name) => name.toLowerCase() === d.rule.name.toLowerCase())!),
});

export const reconcile = (
    current: readonly string[],
    rules: readonly LabelRule[],
    probabilities: ReadonlyMap<string, number>,
): LabelChange => changeOf(current, decideAll(current, rules, probabilities));

export const managedLabelsAfter = (
    current: readonly string[],
    rules: readonly LabelRule[],
    decisions: readonly LabelDecision[],
): string[] => {
    const removed = new Set(decisions.filter((d) => d.action === 'removed').map((d) => d.rule.name.toLowerCase()));
    const labels = [...current.filter((name) => !removed.has(name.toLowerCase())), ...decisions.filter((d) => d.action === 'added').map((d) => d.rule.name)];
    return rules.map((rule) => rule.name).filter((name) => hasLabel(labels, name));
};
