// Minimal typings for the built-in `node:sqlite` module (Node >= 22.13),
// which the pinned @types/node 20 does not describe. Only what the gateway uses.
declare module 'node:sqlite' {
  export type SQLInputValue = null | number | bigint | string | Uint8Array;
  export type SQLOutputValue = null | number | bigint | string | Uint8Array;

  export interface StatementResultingChanges {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }

  export class StatementSync {
    run(...parameters: SQLInputValue[]): StatementResultingChanges;
    get(...parameters: SQLInputValue[]): Record<string, SQLOutputValue> | undefined;
    all(...parameters: SQLInputValue[]): Record<string, SQLOutputValue>[];
  }

  export interface DatabaseSyncOptions {
    open?: boolean;
    readOnly?: boolean;
    enableForeignKeyConstraints?: boolean;
  }

  export class DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
