import type { Frame } from './context.ts';

const SCHEME_AND_HOST = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i;

export function normalizeFramePath(file: string): string {
    return file
        .replace(SCHEME_AND_HOST, '')
        .replaceAll('\\', '/')
        .replace(/^~\//, '')
        .replace(/^[A-Za-z]:\//, '')
        .split('/')
        .filter((segment) => segment !== '' && segment !== '.')
        .join('/');
}

// Two trailing segments, such as gradebook/Grid.js, tell files apart well enough and survive any build prefix.
const MATCHED_SEGMENTS = 2;

export function framePathMatches(framePath: string, repoPath: string): boolean {
    const frame = normalizeFramePath(framePath).split('/');
    const repo = repoPath.split('/');
    const tail = frame.slice(-Math.min(MATCHED_SEGMENTS, frame.length));
    if (tail.length === 0 || tail.length > repo.length) return false;
    return tail.every((segment, i) => segment.toLowerCase() === repo[repo.length - tail.length + i]?.toLowerCase());
}

// A .NET frame without a PDB names a type, such as OnCourse.Web.Services.GradebookService+<>c, not a file.
export function moduleTypeName(module: string): string | undefined {
    const type = module.split('+', 1)[0]?.split('.').at(-1)?.replace(/`\d+$/, '');
    return type ? type : undefined;
}

const baseName = (path: string): string => path.split('/').at(-1)?.replace(/\.[^.]+$/, '') ?? '';

const frameMatches = (frame: Frame, repoPath: string): boolean => {
    if (frame.file !== null) return framePathMatches(frame.file, repoPath);
    const type = frame.module === null ? undefined : moduleTypeName(frame.module);
    return type !== undefined && baseName(repoPath).toLowerCase() === type.toLowerCase();
};

export function pathsInFrames(frames: readonly Frame[], repoPaths: readonly string[]): string[] {
    const inApp = frames.filter((frame) => frame.inApp);
    const considered = inApp.length > 0 ? inApp : frames;
    return repoPaths.filter((path) => considered.some((frame) => frameMatches(frame, path)));
}
