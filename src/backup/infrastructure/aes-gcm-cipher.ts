import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { BackupCipher } from '../application/ports.js';

/**
 * Backup file format (version 1), AES-256-GCM:
 *
 *   "EGBK" | version (1 byte) | key id (8) | IV (12) | context length (2, BE) | context (UTF-8)
 *   | ciphertext | auth tag (16)
 *
 * The whole header is the GCM additional data, so the key id and the context
 * (which unit and file the data belongs to) cannot be altered either. The key
 * id (first 8 bytes of SHA-256 over a label and the key) picks the key on
 * decryption, which is how rotated-out keys keep old snapshots readable.
 */
const MAGIC = Buffer.from('EGBK');
const VERSION = 1;
const KEY_ID_LENGTH = 8;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const FIXED_HEADER = MAGIC.length + 1 + KEY_ID_LENGTH + IV_LENGTH + 2;

export const BACKUP_KEY_BYTES = 32;

export function backupKeyId(key: Buffer): Buffer {
  return createHash('sha256').update('engram-gateway backup key id\0').update(key).digest().subarray(0, KEY_ID_LENGTH);
}

export interface BackupKeys {
  /** Encrypts every new snapshot. */
  key: Buffer;
  /** Older keys, only for reading snapshots taken before a rotation. */
  previousKeys: Buffer[];
}

function header(keyId: Buffer, iv: Buffer, context: string): Buffer {
  const ctx = Buffer.from(context, 'utf8');
  const fixed = Buffer.alloc(FIXED_HEADER);
  MAGIC.copy(fixed, 0);
  fixed.writeUInt8(VERSION, MAGIC.length);
  keyId.copy(fixed, MAGIC.length + 1);
  iv.copy(fixed, MAGIC.length + 1 + KEY_ID_LENGTH);
  fixed.writeUInt16BE(ctx.length, FIXED_HEADER - 2);
  return Buffer.concat([fixed, ctx]);
}

async function readHeader(source: string): Promise<{ header: Buffer; keyId: Buffer; iv: Buffer; context: string; tag: Buffer; size: number }> {
  const handle = await open(source, 'r');
  try {
    const { size } = await handle.stat();
    const fixed = Buffer.alloc(FIXED_HEADER);
    if (size < FIXED_HEADER + TAG_LENGTH) throw new Error(`${source} is not a backup file (too short)`);
    await handle.read(fixed, 0, FIXED_HEADER, 0);
    if (!fixed.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error(`${source} is not a backup file`);
    const version = fixed.readUInt8(MAGIC.length);
    if (version !== VERSION) throw new Error(`${source}: unsupported backup file version ${version}`);
    const ctxLength = fixed.readUInt16BE(FIXED_HEADER - 2);
    if (size < FIXED_HEADER + ctxLength + TAG_LENGTH) throw new Error(`${source} is not a backup file (truncated)`);
    const ctx = Buffer.alloc(ctxLength);
    await handle.read(ctx, 0, ctxLength, FIXED_HEADER);
    const tag = Buffer.alloc(TAG_LENGTH);
    await handle.read(tag, 0, TAG_LENGTH, size - TAG_LENGTH);
    return {
      header: Buffer.concat([fixed, ctx]),
      keyId: fixed.subarray(MAGIC.length + 1, MAGIC.length + 1 + KEY_ID_LENGTH),
      iv: fixed.subarray(MAGIC.length + 1 + KEY_ID_LENGTH, FIXED_HEADER - 2),
      context: ctx.toString('utf8'),
      tag,
      size
    };
  } finally {
    await handle.close();
  }
}

/** AES-256-GCM file encryption with a random IV per file; never logs or returns key material. */
export function createBackupCipher(keys: BackupKeys): BackupCipher {
  for (const key of [keys.key, ...keys.previousKeys]) {
    if (key.length !== BACKUP_KEY_BYTES) throw new Error(`backup keys must be ${BACKUP_KEY_BYTES} bytes`);
  }
  const current = { id: backupKeyId(keys.key), key: keys.key };
  const known = [current, ...keys.previousKeys.map(key => ({ id: backupKeyId(key), key }))];
  return {
    async encryptFile(source, destination, context) {
      const iv = randomBytes(IV_LENGTH);
      const head = header(current.id, iv, context);
      const cipher = createCipheriv('aes-256-gcm', current.key, iv);
      cipher.setAAD(head);
      const out = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
      try {
        out.write(head);
        await pipeline(createReadStream(source), cipher, out, { end: false });
        await new Promise<void>((resolve, reject) => out.end(cipher.getAuthTag(), (error?: Error | null) => (error ? reject(error) : resolve())));
      } catch (error) {
        out.destroy();
        await rm(destination, { force: true });
        throw error;
      }
    },
    async decryptFile(source, destination, context) {
      const parsed = await readHeader(source);
      if (parsed.context !== context) throw new Error(`${source} holds ${JSON.stringify(parsed.context)}, not ${JSON.stringify(context)}`);
      const match = known.find(candidate => candidate.id.equals(parsed.keyId));
      if (!match) throw new Error(`${source} was encrypted with a key that is not configured (add it to BACKUP_PREVIOUS_KEY_FILES)`);
      const decipher = createDecipheriv('aes-256-gcm', match.key, parsed.iv);
      decipher.setAAD(parsed.header);
      decipher.setAuthTag(parsed.tag);
      const body = createReadStream(source, { start: parsed.header.length, end: parsed.size - TAG_LENGTH - 1 });
      try {
        await pipeline(body, decipher, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
      } catch (error) {
        await rm(destination, { force: true });
        const message = (error as Error).message;
        throw new Error(/authenticate/i.test(message) ? `${source} failed to authenticate: altered, truncated or wrong key` : message);
      }
    }
  };
}
