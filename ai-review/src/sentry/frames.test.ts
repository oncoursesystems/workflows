import { describe, expect, it } from 'vitest';
import { framePathMatches, moduleTypeName, normalizeFramePath, pathsInFrames } from './frames.ts';

describe('normalizeFramePath', () => {
    it.each([
        ['https://app.oncourse.net/client/web/app/view/Grid.js', 'client/web/app/view/Grid.js'],
        ['webpack:///./app/view/Grid.js', 'app/view/Grid.js'],
        ['app:///app/view/Grid.js', 'app/view/Grid.js'],
        ['C:\\agent\\_work\\1\\s\\src\\OnCourse.Web\\Grades.cs', 'agent/_work/1/s/src/OnCourse.Web/Grades.cs'],
        ['~/app/Grid.js', 'app/Grid.js'],
    ])('normalizes %s', (input, expected) => expect(normalizeFramePath(input)).toBe(expected));
});

describe('framePathMatches', () => {
    it('matches on the last two segments, whatever the prefix', () => {
        expect(framePathMatches('https://x/app/view/gradebook/Grid.js', 'client/web/app/view/gradebook/Grid.js')).toBe(true);
        expect(framePathMatches('C:\\b\\src\\OnCourse.Web\\Grades.cs', 'src/OnCourse.Web/Grades.cs')).toBe(true);
    });

    it('does not match a file with the same name in another folder', () => {
        expect(framePathMatches('app/view/gradebook/Grid.js', 'client/web/app/view/attendance/Grid.js')).toBe(false);
    });

    it('matches a bare file name on the name alone', () => {
        expect(framePathMatches('Grid.js', 'client/web/app/view/attendance/Grid.js')).toBe(true);
    });
});

describe('moduleTypeName', () => {
    it.each([
        ['OnCourse.Web.Services.GradebookService', 'GradebookService'],
        ['OnCourse.Web.Services.GradebookService+<>c', 'GradebookService'],
        ['OnCourse.Data.Repository`1', 'Repository'],
    ])('reads the type of %s', (module, expected) => expect(moduleTypeName(module)).toBe(expected));
});

describe('pathsInFrames', () => {
    const frame = (file: string | null, module: string | null, inApp: boolean) => ({ file, module, fn: 'f', line: 1, inApp });

    it('looks at in-app frames when there are any', () => {
        const frames = [frame('app/view/Grid.js', null, true), frame('ext/ext-all.js', null, false)];
        expect(pathsInFrames(frames, ['client/web/app/view/Grid.js', 'client/web/ext/ext-all.js', 'README.md'])).toEqual([
            'client/web/app/view/Grid.js',
        ]);
    });

    it('matches a .NET type to its file', () => {
        const frames = [frame(null, 'OnCourse.Web.Services.GradebookService', true)];
        expect(pathsInFrames(frames, ['src/OnCourse.Web/Services/GradebookService.cs', 'src/Other.cs'])).toEqual([
            'src/OnCourse.Web/Services/GradebookService.cs',
        ]);
    });

    it('falls back to every frame when none is in-app', () => {
        expect(pathsInFrames([frame('lib/x.js', null, false)], ['vendor/lib/x.js'])).toEqual(['vendor/lib/x.js']);
    });
});
