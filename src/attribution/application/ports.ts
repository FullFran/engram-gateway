import type { Authorship, WriteKind } from '../domain/authorship.js';

export interface AttributionClock {
  nowMs(): number;
}

export interface RecordedWrite {
  /** Opaque brain key (the slug). */
  brain: string;
  observationId: number;
  syncId?: string;
  login: string;
  /** The connection (#27) the write came through; absent for a single-brain token. */
  connectionId?: number;
  kind: WriteKind;
  atMs: number;
}

/** Where the gateway keeps observation authors (the gateway database). */
export interface AuthorshipRepository {
  /**
   * Records a write. The first `save` of an observation makes `login` its
   * author; later writes only change the last writer. An `update` of an
   * observation with no row leaves the author unknown.
   */
  recordWrite(write: RecordedWrite): void;
  /** Forgets an observation deleted through the gateway. */
  remove(brain: string, observationId: number): void;
  /** Known authorships among `ids` in `brain`, in the order of `ids`; unknown ids are left out. */
  find(brain: string, ids: readonly number[]): Authorship[];
}
