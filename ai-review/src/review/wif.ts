import { z } from 'zod';

export const ANTHROPIC_AUDIENCE = 'https://api.anthropic.com';

const TOKEN_URL = 'https://api.anthropic.com/v1/oauth/token';

export type Federation = { ruleId: string; organizationId: string; serviceAccountId: string; workspaceId: string };

const TokenResponse = z.object({ access_token: z.string().min(1) });

export async function exchangeIdentityToken(federation: Federation, identityToken: string, fetchImpl: typeof fetch = fetch): Promise<string> {
    const response = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: identityToken,
            federation_rule_id: federation.ruleId,
            organization_id: federation.organizationId,
            service_account_id: federation.serviceAccountId,
            workspace_id: federation.workspaceId,
        }),
    });
    if (!response.ok) {
        throw new Error(
            `The Anthropic token exchange failed with ${response.status}: ${await response.text()}. ` +
                'The deny reason is on the authentication history tab of the Workload identity page in the Claude Console.',
        );
    }
    return TokenResponse.parse(await response.json()).access_token;
}
