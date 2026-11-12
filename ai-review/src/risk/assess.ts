import { classify, type Classification } from './classify.ts';
import type { JevOptions } from '../jev/transport.ts';
import { askJev, type JevResult } from './jev.ts';
import { policyOf, type PolicyLookup } from './policy.ts';
import type { PullRequest } from '../github/pull-request.ts';

export type JevMode = { kind: 'ask'; options: JevOptions } | { kind: 'skip' };

export async function assess(pr: PullRequest, lookup: PolicyLookup, mode: JevMode): Promise<Classification> {
    const jev: JevResult =
        mode.kind === 'ask'
            ? await askJev(pr, policyOf(lookup), mode.options)
            : { status: 'skipped' };
    return classify(pr, lookup, jev);
}
