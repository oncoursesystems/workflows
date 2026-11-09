import { describe, expect, it } from 'vitest';
import { exchangeIdentityToken } from './wif.ts';

const federation = { ruleId: 'fdrl_1', organizationId: 'org-uuid', serviceAccountId: 'svac_1', workspaceId: 'wrkspc_1' };

describe('exchangeIdentityToken', () => {
    it('sends the GitHub token with the jwt-bearer grant and the rule, and returns the access token', async () => {
        let sent: { url: string; body: unknown } | undefined;
        const fakeFetch = (async (url: string, init: RequestInit) => {
            sent = { url, body: JSON.parse(String(init.body)) };
            return new Response(JSON.stringify({ access_token: 'sk-ant-oat01-minted', expires_in: 3600 }), { status: 200 });
        }) as unknown as typeof fetch;
        await expect(exchangeIdentityToken(federation, 'github.jwt', fakeFetch)).resolves.toBe('sk-ant-oat01-minted');
        expect(sent).toEqual({
            url: 'https://api.anthropic.com/v1/oauth/token',
            body: {
                grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                assertion: 'github.jwt',
                federation_rule_id: 'fdrl_1',
                organization_id: 'org-uuid',
                service_account_id: 'svac_1',
                workspace_id: 'wrkspc_1',
            },
        });
    });

    it('says where to find the reason when the exchange is denied', async () => {
        const denied = (async () => new Response('{"error":{"message":"Authentication failed"}}', { status: 401 })) as unknown as typeof fetch;
        await expect(exchangeIdentityToken(federation, 'github.jwt', denied)).rejects.toThrow(
            /failed with 401: .*Authentication failed.*authentication history/,
        );
    });
});
