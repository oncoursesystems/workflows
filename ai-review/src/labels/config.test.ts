import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lookupConfig, parseConfig } from './config.ts';

const rulesOf = (text: string) => {
    const parsed = parseConfig(text);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.rules;
};

const errorOf = (text: string) => {
    const parsed = parseConfig(text);
    expect(parsed.ok).toBe(false);
    return parsed.ok ? '' : parsed.error;
};

describe('parseConfig', () => {
    it('accepts the calibrated oncourse-connect config as written', () => {
        const [ai, ...others] = rulesOf(readFileSync(new URL('fixtures/oncourse-connect.yml', import.meta.url), 'utf8'));
        expect(others).toEqual([]);
        expect(ai).toMatchObject({
            name: 'ai',
            color: '5319e7',
            description: 'Adds or changes an AI feature of the application',
            addAt: 0.7,
            removeAt: 0.3,
            criteria: { true: expect.stringContaining('AI feature') },
        });
        expect(ai?.instructions).toMatchObject({ task: expect.stringContaining('ai_features'), ai_features: expect.any(Array) });
    });

    it('keeps a color that YAML would read as a number', () => {
        const rules = rulesOf('labels:\n  a:\n    color: 5319e7\n    instructions: q\n  b:\n    color: 123456\n    instructions: q\n  c:\n    color: 0E8A16\n    instructions: q\n');
        expect(rules.map((rule) => rule.color)).toEqual(['5319e7', '123456', '0e8a16']);
    });

    it('defaults the thresholds and leaves optional fields out', () => {
        expect(rulesOf('labels:\n  needs-docs:\n    instructions: Does it change behavior?\n')).toEqual([
            { name: 'needs-docs', instructions: 'Does it change behavior?', addAt: 0.7, removeAt: 0.3 },
        ]);
    });

    it('keeps label order and every threshold', () => {
        const rules = rulesOf(
            'labels:\n  b:\n    instructions: q\n    add_at: 0.9\n    remove_at: 0.9\n  a:\n    instructions: q\n    add_at: 0.5\n    remove_at: 0\n',
        );
        expect(rules.map((rule) => [rule.name, rule.addAt, rule.removeAt])).toEqual([['b', 0.9, 0.9], ['a', 0.5, 0]]);
    });

    it('rejects a file with no labels', () => {
        expect(errorOf('labels: {}\n')).toBe('labels: at least one label is required');
        expect(errorOf('{}\n')).toContain('labels: ');
    });

    it('rejects a remove_at above add_at and names the label', () => {
        expect(errorOf('labels:\n  ai:\n    instructions: q\n    add_at: 0.4\n    remove_at: 0.6\n')).toMatch(
            /^labels\.ai\.remove_at: must be at most add_at/,
        );
    });

    it('rejects a default remove_at above a low add_at', () => {
        expect(errorOf('labels:\n  ai:\n    instructions: q\n    add_at: 0.2\n')).toContain('labels.ai.remove_at');
    });

    it('rejects a missing instructions field', () => {
        expect(errorOf('labels:\n  ai:\n    color: 5319e7\n')).toMatch(/^labels\.ai\.instructions: /);
    });

    it('rejects an unknown key, so a typo does not silently use a default', () => {
        expect(errorOf('labels:\n  ai:\n    instructions: q\n    addat: 0.8\n')).toContain('addat');
        expect(errorOf('labels:\n  ai:\n    instructions: q\nextra: 1\n')).toContain('extra');
    });

    it('rejects a threshold outside 0 to 1', () => {
        expect(errorOf('labels:\n  ai:\n    instructions: q\n    add_at: 1.5\n')).toMatch(/^labels\.ai\.add_at: /);
        expect(errorOf('labels:\n  ai:\n    instructions: q\n    remove_at: -0.1\n')).toMatch(/^labels\.ai\.remove_at: /);
    });

    it('rejects a color that is not six hex digits', () => {
        expect(errorOf('labels:\n  ai:\n    instructions: q\n    color: "#5319e7"\n')).toMatch(/^labels\.ai\.color: /);
        expect(errorOf('labels:\n  ai:\n    instructions: q\n    color: purple\n')).toMatch(/^labels\.ai\.color: /);
    });

    it('rejects criteria that lack the false side', () => {
        expect(errorOf('labels:\n  ai:\n    instructions: q\n    criteria:\n      true: yes\n')).toMatch(/^labels\.ai\.criteria\.false: /);
    });

    it('rejects names that differ only by case', () => {
        expect(errorOf('labels:\n  AI:\n    instructions: q\n  ai:\n    instructions: q\n')).toContain('differ by more than case');
    });

    it('rejects a label name that GitHub would refuse', () => {
        expect(errorOf(`labels:\n  ${'x'.repeat(51)}:\n    instructions: q\n`)).toContain('labels.');
    });

    it('reports malformed YAML and duplicate keys', () => {
        expect(errorOf('labels: [unclosed\n')).toMatch(/^YAML: /);
        expect(errorOf('labels:\n  ai:\n    instructions: q\n  ai:\n    instructions: r\n')).toMatch(/^YAML: /);
    });
});

describe('lookupConfig', () => {
    it('reports an invalid file with its ref and error', () => {
        expect(lookupConfig('surprise: true\n', 'master')).toEqual({ kind: 'invalid', ref: 'master', error: expect.stringContaining('surprise') });
    });

    it('returns the rules of a valid file', () => {
        expect(lookupConfig('labels:\n  a:\n    instructions: q\n', 'master')).toMatchObject({ kind: 'found', rules: [{ name: 'a' }] });
    });
});
