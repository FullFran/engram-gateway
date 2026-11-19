/**
 * Who wrote an observation in a shared brain (#21), as the gateway saw it.
 * Engram has no author column, so this is the gateway's own record. An
 * author the gateway did not see (a write before attribution existed, or
 * straight through engram) is `null`: never guessed.
 */
export interface Authorship {
  observationId: number;
  /** First author; null when the observation was created without the gateway seeing who. */
  savedBy: string | null;
  /** Whoever wrote it last through the gateway. Null only if that user was removed. */
  lastUpdatedBy: string | null;
}

/** How a write tool relates to the observation id in its result. */
export type WriteKind =
  /** Creates an observation, or revises one through `topic_key` (same id back). */
  | 'save'
  /** Changes an existing observation; its first author stays as recorded (or unknown). */
  | 'update';

/** Write tools whose successful result names the observation they wrote. */
export const WRITE_TOOLS: Readonly<Record<string, WriteKind>> = {
  mem_save: 'save',
  mem_session_summary: 'save',
  mem_capture_passive: 'save',
  mem_update: 'update'
};

/** Header of the text item added to read results. */
export const AUTHORS_HEADER = 'Authors recorded by the gateway (observations not listed have no known author):';

/** One line per observation: `#2 saved by alice, last updated by bob`. */
export function describeAuthorship(authorship: Authorship): string {
  const { observationId: id, savedBy, lastUpdatedBy } = authorship;
  const first = savedBy === null ? `#${id} author unknown` : `#${id} saved by ${savedBy}`;
  if (lastUpdatedBy === null || (savedBy !== null && lastUpdatedBy.toLowerCase() === savedBy.toLowerCase())) return first;
  return `${first}, last updated by ${lastUpdatedBy}`;
}

/** The text item shown with a read result; ordered as given. */
export function describeAuthors(authors: readonly Authorship[]): string {
  return [AUTHORS_HEADER, ...authors.map(describeAuthorship)].join('\n');
}
