/** Why an admin operation was refused, as a fixed word (the HTTP adapter maps it to a status). */
export type AdminErrorCode = 'forbidden' | 'invalid' | 'not_found' | 'conflict';

/** A refused admin operation; the message is safe to show (names, never secrets). */
export class AdminError extends Error {
  constructor(readonly code: AdminErrorCode, message: string) {
    super(message);
    this.name = 'AdminError';
  }
}
