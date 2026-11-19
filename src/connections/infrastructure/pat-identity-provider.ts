import type { IdentityProvider } from '../../auth/index.js';
import type { PersonalAccessTokens } from '../application/personal-access-tokens.js';
import { MEMORY_SCOPE_FOR_PATS, PAT_PROVIDER } from '../domain/personal-access-token.js';

/**
 * PATs as an identity provider of the request authenticator: a bearer
 * starting with `egw_pat_` is answered here and nowhere else's answer
 * matters (other providers do not know it). The token is bound to its
 * connection's brains, not to an OAuth audience, so the target is ignored;
 * the brain check happens per call (and per `/mcp/<slug>` request).
 * Refused tokens answer `invalid_token`: 401 with the standard challenge.
 */
export function patIdentityProvider(tokens: PersonalAccessTokens): IdentityProvider {
  return {
    id: PAT_PROVIDER,
    bearer(token) {
      const answer = tokens.authenticate(token);
      if (answer.kind === 'none') return { kind: 'none' };
      if (answer.kind === 'invalid') return { kind: 'invalid', error: 'invalid_token' };
      return {
        kind: 'ok',
        identity: {
          provider: PAT_PROVIDER, subject: answer.login, via: 'bearer', clientId: `pat:${answer.patId}`,
          scopes: [MEMORY_SCOPE_FOR_PATS], expiresAt: answer.expiresAt, connectionId: answer.connectionId
        }
      };
    }
  };
}
