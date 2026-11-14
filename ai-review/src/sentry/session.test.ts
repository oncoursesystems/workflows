import { describe, expect, it } from 'vitest';
import { SessionLimitError, UsageLimitError } from '../review/agent.ts';
import { sessionFailure } from './session.ts';

describe('sessionFailure', () => {
    it('tells running out of budget or turns apart from a usage limit and any other error', () => {
        expect(sessionFailure(new SessionLimitError('claude-opus-5-5 stopped with error_max_budget_usd: x'))).toEqual({
            status: 'exhausted',
            error: 'claude-opus-5-5 stopped with error_max_budget_usd: x',
        });
        expect(sessionFailure(new UsageLimitError('Claude hit its five_hour limit'))).toEqual({ status: 'usage-limit', error: 'Claude hit its five_hour limit' });
        expect(sessionFailure(new Error('overloaded'))).toEqual({ status: 'error', error: 'overloaded' });
        expect(sessionFailure('boom')).toEqual({ status: 'error', error: 'boom' });
    });
});
