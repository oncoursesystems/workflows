export const DEFAULT_JEV_MODEL = 'jev-1.14.0';
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const REQUEST_TIMEOUT_MS = 60_000;
const ATTEMPTS = 3;
const BASE_BACKOFF_MS = 2_000;
const RETRYABLE_STATUSES = new Set([429, 529]);
const ERROR_TEXT_LIMIT = 500;

export type JevOptions = {
    apiKey: string;
    model: string;
    fetch?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
};

export type Attempt =
    | { kind: 'ok'; body: unknown }
    | { kind: 'too-long' }
    | { kind: 'error'; error: string };

const truncate = (text: string): string =>
    text.length > ERROR_TEXT_LIMIT ? `${text.slice(0, ERROR_TEXT_LIMIT)}...` : text;

export function retryDelayMs(retryAfter: string | null, attempt: number): number {
    if (retryAfter !== null) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
        const date = Date.parse(retryAfter);
        if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
    }
    return BASE_BACKOFF_MS * 2 ** attempt;
}

export async function post(body: string, options: JevOptions): Promise<Attempt> {
    const doFetch = options.fetch ?? fetch;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 0; ; attempt++) {
        let response: Response;
        try {
            response = await doFetch(ENDPOINT, {
                method: 'POST',
                headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
                body,
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
        } catch (error) {
            const name = (error as Error).name;
            if (name === 'TimeoutError') return { kind: 'error', error: `timed out after ${REQUEST_TIMEOUT_MS / 1000}s` };
            return { kind: 'error', error: `request failed: ${truncate((error as Error).message)}` };
        }
        if (response.ok) {
            try {
                return { kind: 'ok', body: await response.json() };
            } catch {
                return { kind: 'error', error: 'response was not JSON' };
            }
        }
        const text = await response.text().catch(() => '');
        if (response.status === 400 && text.includes('max_tokens_exceeded')) return { kind: 'too-long' };
        if (RETRYABLE_STATUSES.has(response.status) && attempt + 1 < ATTEMPTS) {
            await sleep(retryDelayMs(response.headers.get('retry-after'), attempt));
            continue;
        }
        return { kind: 'error', error: `HTTP ${response.status}: ${truncate(text)}` };
    }
}
