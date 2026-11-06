import { describe, expect, it } from 'vitest';
import { lookupPolicy, parsePolicy } from './policy.ts';

const SAMPLE = `
minimum_risk:
  high: [ "src/Auth/**", ".github/workflows/**", "review-policy.yml" ]
  medium: [ "src/Data/**", "**/*.config" ]
low_max_changed_lines: 400
ignore: [ "**/ext/**", "**/bootstrap.json", "**/package-lock.json" ]
sensitive_areas:
  - name: Grades and transcripts
    covers: grades and GPAs (gradebook)
trusted_team: example-org/trusted-authors
policy_admins: example-org/policy-admins
`;

describe('parsePolicy', () => {
    it('maps the documented file into the policy', () => {
        expect(parsePolicy(SAMPLE)).toEqual({
            ok: true,
            policy: {
                minimumRisk: {
                    low: [],
                    medium: ['src/Data/**', '**/*.config'],
                    high: ['src/Auth/**', '.github/workflows/**', 'review-policy.yml'],
                },
                lowMaxChangedLines: 400,
                ignore: ['**/ext/**', '**/bootstrap.json', '**/package-lock.json'],
                sensitiveAreas: [{ name: 'Grades and transcripts', covers: 'grades and GPAs (gradebook)' }],
                trustedTeam: 'example-org/trusted-authors',
                policyAdmins: 'example-org/policy-admins',
            },
        });
    });

    it('defaults omitted keys', () => {
        const parsed = parsePolicy('ignore: []');
        expect(parsed).toEqual({
            ok: true,
            policy: { minimumRisk: { low: [], medium: [], high: [] }, lowMaxChangedLines: 400, ignore: [], sensitiveAreas: [] },
        });
    });

    it('rejects unknown keys', () => {
        const parsed = parsePolicy('minimum-risk:\n  high: [ "x/**" ]\n');
        expect(parsed.ok).toBe(false);
        expect(!parsed.ok && parsed.error).toContain('minimum-risk');
    });

    it('rejects an unknown tier', () => {
        const parsed = parsePolicy('minimum_risk:\n  critical: [ "x/**" ]\n');
        expect(parsed.ok).toBe(false);
        expect(!parsed.ok && parsed.error).toContain('critical');
    });

    it('names the field with a wrong type', () => {
        const parsed = parsePolicy('low_max_changed_lines: lots\n');
        expect(parsed.ok).toBe(false);
        expect(!parsed.ok && parsed.error).toMatch(/^low_max_changed_lines: /);
    });

    it('reports malformed YAML as an error', () => {
        const parsed = parsePolicy('minimum_risk: [unclosed\n');
        expect(parsed.ok).toBe(false);
        expect(!parsed.ok && parsed.error).toMatch(/^YAML: /);
    });
});

describe('lookupPolicy', () => {
    it('reports an invalid file with its error', () => {
        expect(lookupPolicy('surprise: true\n', 'master')).toEqual({
            kind: 'invalid',
            ref: 'master',
            error: expect.stringContaining('surprise'),
        });
    });
});
