import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Synchronizer CSRF tokens for the panel's forms, bound to the browser
 * session: the token is an HMAC of the session binding (the signed session
 * cookie, which carries a random session id), so it is the same for every
 * form of one session and useless with any other session. Stateless; the key
 * is random per process unless one is given, so a restart only asks the user
 * to reload the form.
 */
export class CsrfTokens {
  private readonly key: Buffer;

  constructor(secret: Buffer = randomBytes(32)) {
    this.key = createHmac('sha256', secret).update('engram-gateway/ui-csrf/v1').digest();
  }

  issue(binding: string): string {
    return createHmac('sha256', this.key).update(binding).digest('base64url');
  }

  verify(binding: string, presented: unknown): boolean {
    if (typeof presented !== 'string' || presented.length === 0 || presented.length > 128) return false;
    const expected = Buffer.from(this.issue(binding));
    const given = Buffer.from(presented);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
}
