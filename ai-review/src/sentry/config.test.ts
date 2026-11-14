import { describe, expect, it } from 'vitest';
import { appOf, parseConfig, renderRelease } from './config.ts';

const FULL = `
limit: 3
environment: staging
period: 14d
projects:
  - slug: oncourse-dotnet
    description: The ASP.NET server
    roots: [src/, client/web]
  - slug: oncourse-web
    description: The ExtJS client
    roots: [client/web]
apps:
  - name: web
    release: OnCourse.Web@{version}
    projects: [oncourse-dotnet, oncourse-web]
`;

const configOf = (text: string) => {
    const parsed = parseConfig(text);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.config;
};

const errorOf = (text: string) => {
    const parsed = parseConfig(text);
    expect(parsed.ok).toBe(false);
    return parsed.ok ? '' : parsed.error;
};

const minimal = (project: string) => `projects:\n  - slug: p\n    description: d\n    roots: [src]\n${project}`;

describe('parseConfig', () => {
    it('reads every field and drops a trailing slash from a root', () => {
        expect(configOf(FULL)).toEqual({
            limit: 3,
            environment: 'staging',
            period: '14d',
            projects: [
                { slug: 'oncourse-dotnet', description: 'The ASP.NET server', roots: ['src', 'client/web'] },
                { slug: 'oncourse-web', description: 'The ExtJS client', roots: ['client/web'] },
            ],
            apps: [{ name: 'web', release: 'OnCourse.Web@{version}', projects: ['oncourse-dotnet', 'oncourse-web'] }],
        });
    });

    it('defaults the limit, the environment, the period and the apps', () => {
        expect(configOf(minimal(''))).toMatchObject({ limit: 5, environment: 'production', period: '7d', apps: [] });
    });

    it('accepts the repository root as a root', () => {
        expect(configOf('projects:\n  - slug: p\n    description: d\n    roots: [./]\n').projects[0]?.roots).toEqual(['.']);
    });

    it.each([
        ['an absolute root', '/src'],
        ['a root that climbs out', 'src/../..'],
        ['a glob', 'src/**'],
    ])('rejects %s', (_name, path) => {
        expect(errorOf(`projects:\n  - slug: p\n    description: d\n    roots: ["${path}"]\n`)).toContain('roots.0');
    });

    it('rejects a project with no roots, and an unknown key', () => {
        expect(errorOf('projects:\n  - slug: p\n    description: d\n    roots: []\n')).toContain('roots');
        expect(errorOf(minimal('    branch: x\n'))).toContain('branch');
    });

    it('rejects duplicate project slugs', () => {
        expect(errorOf(`${minimal('')}  - slug: p\n    description: d\n    roots: [src]\n`)).toContain('unique');
    });

    it('rejects an app whose release has no version placeholder, or that names an unknown project', () => {
        expect(errorOf(`${minimal('')}apps:\n  - name: web\n    release: OnCourse.Web\n    projects: [p]\n`)).toContain('{version}');
        expect(errorOf(`${minimal('')}apps:\n  - name: web\n    release: W@{version}\n    projects: [q]\n`)).toContain(
            'q is not one of the projects',
        );
    });

    it('reports a YAML error', () => {
        expect(errorOf('projects: [')).toMatch(/^YAML:/);
    });
});

describe('renderRelease', () => {
    it('puts the version into the template', () => {
        const app = appOf(configOf(FULL), 'web');
        expect(app && renderRelease(app, '2026.11.13.1200')).toBe('OnCourse.Web@2026.11.13.1200');
    });
});
