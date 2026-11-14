import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runAgent } from '../review/agent.ts';
import { CONTAINER } from './docker.ts';
import { FixOutput } from './fix.ts';
import { parseJson } from './handoff.ts';
import { REQUEST_FILE, SESSION_FILE, SessionRequest, sessionFailure, type SessionResult } from './session.ts';

// The entry point inside the fixer's container. The container's env is already the allowlist, so it is the session's.

const request = parseJson(await readFile(join(CONTAINER.session, REQUEST_FILE), 'utf8'), SessionRequest, 'the session request');
// Claude Code's subprocess env scrub needs bubblewrap, which cannot create namespaces in this unprivileged container,
// and with it on Claude Code refuses to start. The container is the isolation instead.
const env: Record<string, string> = { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '0' };
for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] ??= value;

let result: SessionResult;
try {
    const run = await runAgent({ ...request, schema: FixOutput, cwd: CONTAINER.work, env });
    const { billing, costUsd, turns, durationMs, denied } = run.stats;
    result = { status: 'done', output: run.output, stats: { billing, costUsd, turns, durationMs, denied } };
} catch (error) {
    result = sessionFailure(error);
}
await writeFile(join(CONTAINER.session, SESSION_FILE), JSON.stringify(result));
console.log(`sentry-fix session: ${result.status}`);
