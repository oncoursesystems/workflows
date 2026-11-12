import { describe, expect, it } from 'vitest';
import type { LabelRule } from './config.ts';
import { decide, decideAll, managedLabelsAfter, reconcile } from './reconcile.ts';

const rule = (name: string, addAt = 0.7, removeAt = 0.3): LabelRule => ({ name, instructions: 'q', addAt, removeAt });
const answers = (entries: Record<string, number>) => new Map(Object.entries(entries));

describe('reconcile', () => {
    const rules = [rule('ai')];

    it('adds an absent label at or above add_at', () => {
        expect(reconcile(['bug'], rules, answers({ ai: 0.7 }))).toEqual({ add: ['ai'], remove: [] });
        expect(reconcile([], rules, answers({ ai: 0.99 }))).toEqual({ add: ['ai'], remove: [] });
    });

    it('removes a present label below remove_at', () => {
        expect(reconcile(['bug', 'ai'], rules, answers({ ai: 0.29 }))).toEqual({ add: [], remove: ['ai'] });
    });

    it('keeps the label as it is between the thresholds', () => {
        expect(reconcile(['ai'], rules, answers({ ai: 0.5 }))).toEqual({ add: [], remove: [] });
        expect(reconcile([], rules, answers({ ai: 0.5 }))).toEqual({ add: [], remove: [] });
        expect(reconcile([], rules, answers({ ai: 0.69 }))).toEqual({ add: [], remove: [] });
        expect(reconcile(['ai'], rules, answers({ ai: 0.3 }))).toEqual({ add: [], remove: [] });
    });

    it('does nothing when the label already matches the answer', () => {
        expect(reconcile(['ai'], rules, answers({ ai: 0.9 }))).toEqual({ add: [], remove: [] });
        expect(reconcile([], rules, answers({ ai: 0.01 }))).toEqual({ add: [], remove: [] });
    });

    it('never touches labels that are not in the config', () => {
        const change = reconcile(['bug', 'risk:high', 'ai'], rules, answers({ ai: 0.0 }));
        expect(change).toEqual({ add: [], remove: ['ai'] });
    });

    it('treats label names the way GitHub does, ignoring case, and removes the label by its existing name', () => {
        expect(reconcile(['AI'], rules, answers({ ai: 0.9 }))).toEqual({ add: [], remove: [] });
        expect(reconcile(['AI'], rules, answers({ ai: 0.1 }))).toEqual({ add: [], remove: ['AI'] });
    });

    it('decides each label on its own thresholds', () => {
        const many = [rule('a', 0.9, 0.5), rule('b', 0.5, 0.5), rule('c')];
        expect(reconcile(['a', 'b'], many, answers({ a: 0.6, b: 0.49, c: 0.8 }))).toEqual({ add: ['c'], remove: ['b'] });
    });

    it('converges: applying the change and rerunning on the same answers changes nothing', () => {
        const many = [rule('a'), rule('b'), rule('c'), rule('d')];
        const given = answers({ a: 0.95, b: 0.05, c: 0.5, d: 0.5 });
        const start = ['b', 'c', 'bug'];
        const first = reconcile(start, many, given);
        const after = [...start.filter((name) => !first.remove.includes(name)), ...first.add];
        expect(reconcile(after, many, given)).toEqual({ add: [], remove: [] });
    });

    it('does not flap: an answer inside the band keeps whichever state the label had', () => {
        const band = answers({ ai: 0.5 });
        expect(reconcile(['ai'], rules, band)).toEqual({ add: [], remove: [] });
        expect(reconcile([], rules, band)).toEqual({ add: [], remove: [] });
    });

    it('fails when an answer is missing instead of guessing', () => {
        expect(() => reconcile([], rules, answers({}))).toThrow('no answer for label "ai"');
    });
});

describe('decide', () => {
    it('names the action for the summary', () => {
        const r = rule('ai');
        expect([decide(r, false, 0.8), decide(r, true, 0.8), decide(r, true, 0.1), decide(r, false, 0.1), decide(r, true, 0.5)]).toEqual([
            'added',
            'unchanged',
            'removed',
            'unchanged',
            'kept',
        ]);
    });
});

describe('managedLabelsAfter', () => {
    it('lists the managed labels on the pull request once the change is applied', () => {
        const rules = [rule('a'), rule('b'), rule('c')];
        const current = ['bug', 'b', 'c'];
        const decisions = decideAll(current, rules, answers({ a: 0.9, b: 0.1, c: 0.5 }));
        expect(managedLabelsAfter(current, rules, decisions)).toEqual(['a', 'c']);
    });
});
