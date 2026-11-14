import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attributePaths, collectChanges, gitEnv, gitIn, parseStatus, snapshot, tamperedPaths } from './git.ts';

describe('gitEnv', () => {
    it('is PATH and HOME with no system or global config, and nothing else from the runner', () => {
        const runner = {
            PATH: '/usr/bin',
            HOME: '/home/runner',
            CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x',
            ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'id',
            ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token',
            GITHUB_TOKEN: 'ghs',
            GIT_CONFIG_GLOBAL: '/home/runner/evil.gitconfig',
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'core.pager',
            GIT_DIR: '/elsewhere',
            GIT_EXTERNAL_DIFF: '/bin/evil',
        };
        expect(gitEnv(runner)).toEqual({ PATH: '/usr/bin', HOME: '/home/runner', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
    });
});

describe('parseStatus', () => {
    it('reads work tree changes and untracked paths, spaces included', () => {
        const raw =
            '1 .M N... 100644 100644 100644 1111111111111111111111111111111111111111 1111111111111111111111111111111111111111 client/web/a b.js\0' +
            '1 .T N... 100644 100644 120000 2222222222222222222222222222222222222222 2222222222222222222222222222222222222222 client/web/link\0' +
            '1 .D N... 100644 100644 000000 3333333333333333333333333333333333333333 3333333333333333333333333333333333333333 client/web/old.js\0' +
            '? client/web/new.js\0';
        expect(parseStatus(raw)).toEqual([
            { kind: 'tracked', path: 'client/web/a b.js', status: 'modified', mode: '100644' },
            { kind: 'tracked', path: 'client/web/link', status: 'modified', mode: '120000' },
            { kind: 'tracked', path: 'client/web/old.js', status: 'deleted', mode: '000000' },
            { kind: 'untracked', path: 'client/web/new.js' },
        ]);
    });

    it('refuses a staged change, which the read-only index rules out', () => {
        expect(() => parseStatus('1 M. N... 100644 100644 100644 1 2 a.js\0')).toThrow('unexpected git status entry');
    });
});

describe('attributePaths', () => {
    it('names a .gitattributes in every directory above a tracked file, and nowhere else', () => {
        expect(attributePaths(['README.md', 'client/web/app/Grid.js', 'client/web/package.json', 'src/A.cs'])).toEqual([
            '.gitattributes',
            'client/.gitattributes',
            'client/web/.gitattributes',
            'client/web/app/.gitattributes',
            'src/.gitattributes',
        ]);
    });
});

describe('the harness git calls', () => {
    let dir: string;
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'sentry-git-'));
        run('init', '--quiet', '--initial-branch=main');
        run('config', 'user.email', 't@example.com');
        run('config', 'user.name', 'Test');
        mkdirSync(join(dir, 'client/web'), { recursive: true });
        writeFileSync(join(dir, 'client/web/grid.js'), 'load();\n');
        writeFileSync(join(dir, 'client/web/.gitattributes'), '*.js text\n');
        writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
        run('add', '.');
        run('commit', '--quiet', '-m', 'base');
    });

    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('never runs a filter from a global config the runner env points at', async () => {
        const pwned = join(dir, '..', `pwned-${Date.now()}`);
        const global = join(dir, 'evil.gitconfig');
        writeFileSync(global, `[filter "x"]\n\tclean = touch ${pwned}\n`);
        writeFileSync(join(dir, '.gitattributes'), '* filter=x\n');
        writeFileSync(join(dir, 'client/web/grid.js'), 'load(); // changed\n');
        const git = gitIn(dir, { PATH: process.env['PATH'], HOME: dir, GIT_CONFIG_GLOBAL: global });
        const before = await snapshot(git, dir);
        await collectChanges(git, dir, before, ['client/web']);
        expect(existsSync(pwned)).toBe(false);
    });

    it('sees a changed .git/config or .gitattributes, an added one, and none in an untracked directory', async () => {
        const git = gitIn(dir);
        const before = await snapshot(git, dir);
        expect([...before.fingerprints.keys()]).toEqual(['.git/config', '.gitattributes', 'client/.gitattributes', 'client/web/.gitattributes']);
        expect(await tamperedPaths(dir, before)).toEqual([]);

        mkdirSync(join(dir, 'client/web/node_modules/pkg'), { recursive: true });
        writeFileSync(join(dir, 'client/web/node_modules/pkg/.gitattributes'), '* -text\n');
        expect(await tamperedPaths(dir, before)).toEqual([]);

        writeFileSync(join(dir, '.git/config'), '[filter "x"]\n\tclean = sh -c evil\n', { flag: 'a' });
        writeFileSync(join(dir, 'client/web/.gitattributes'), '* filter=x\n');
        writeFileSync(join(dir, 'client/.gitattributes'), '* filter=x\n');
        expect(await tamperedPaths(dir, before)).toEqual(['.git/config', 'client/.gitattributes', 'client/web/.gitattributes']);
    });

    it('sees a .gitattributes replaced by a symlink', async () => {
        const before = await snapshot(gitIn(dir), dir);
        rmSync(join(dir, 'client/web/.gitattributes'));
        symlinkSync('/etc/hostname', join(dir, 'client/web/.gitattributes'));
        expect(await tamperedPaths(dir, before)).toEqual(['client/web/.gitattributes']);
    });

    it('snapshots untracked paths, and leaves out untracked build output that was there before or is outside the roots', async () => {
        mkdirSync(join(dir, 'client/web/coverage'), { recursive: true });
        writeFileSync(join(dir, 'client/web/coverage/old.json'), '{}');
        const git = gitIn(dir);
        const before = await snapshot(git, dir);
        expect([...before.untracked]).toEqual(['client/web/coverage/old.json']);

        mkdirSync(join(dir, 'TestResults'), { recursive: true });
        writeFileSync(join(dir, 'TestResults/run.trx'), '<xml/>');
        writeFileSync(join(dir, 'client/web/coverage/old.json'), '{"changed":true}');
        writeFileSync(join(dir, 'client/web/grid.test.js'), 'test();\n');
        writeFileSync(join(dir, 'client/web/run.sh'), 'echo\n');
        chmodSync(join(dir, 'client/web/run.sh'), 0o755);
        writeFileSync(join(dir, '.gitignore'), 'changed\n');

        const changes = await collectChanges(git, dir, before, ['client/web']);
        expect(changes.map(({ path, status, mode }) => [path, status, mode])).toEqual([
            ['.gitignore', 'modified', '100644'],
            ['client/web/grid.test.js', 'added', '100644'],
            ['client/web/run.sh', 'added', '100755'],
        ]);
    });

    it('never reads a file through a symlinked directory', async () => {
        const git = gitIn(dir);
        const before = await snapshot(git, dir);
        const outside = mkdtempSync(join(tmpdir(), 'sentry-outside-'));
        writeFileSync(join(outside, 'secret.txt'), 'runner secret');
        symlinkSync(outside, join(dir, 'client/web/linked'));
        const changes = await collectChanges(git, dir, before, ['client/web']);
        rmSync(outside, { recursive: true, force: true });
        expect(changes).toEqual([{ path: 'client/web/linked', status: 'added', mode: '120000', content: null }]);
    });
});
