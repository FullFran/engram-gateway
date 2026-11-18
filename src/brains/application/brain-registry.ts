import type { Logger } from '../../shared/logger.js';
import type { Brain } from '../domain/brain.js';
import type { BrainProcess, Clock } from './ports.js';

/** Every allowed child is busy: a new brain cannot be started right now. */
export class BrainCapacityError extends Error {
  constructor(max: number) {
    super(`all ${max} live brains are busy`);
    this.name = 'BrainCapacityError';
  }
}

export interface BrainRegistryOptions<P extends BrainProcess> {
  /** The brains that may be served, by slug. */
  brains: ReadonlyMap<string, Brain>;
  /** Builds a brain's process; it should spawn its child lazily, on first use. */
  createProcess(brain: Brain): P;
  clock: Clock;
  /** A process with no request in flight for this long is stopped. */
  idleTimeoutMs: number;
  /** At most this many processes at once; the least recently used idle one makes room. */
  maxLiveBrains: number;
  logger: Logger;
}

/** A brain in use by one request; `release()` once the response is finished. */
export interface BrainLease<P> {
  process: P;
  release(): void;
}

interface Entry<P> {
  brain: Brain;
  process: P;
  inFlight: number;
  lastUsedAt: number;
}

/**
 * One Engram process per brain: created on the first request for that brain,
 * stopped after `idleTimeoutMs` without requests, bounded by `maxLiveBrains`
 * (least recently used idle brain evicted first). Requests in flight keep
 * their brain alive.
 */
export class BrainRegistry<P extends BrainProcess> {
  private readonly entries = new Map<string, Entry<P>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(private readonly options: BrainRegistryOptions<P>) {}

  /** Whether `slug` is a brain this gateway serves. */
  has(slug: string): boolean {
    return this.options.brains.has(slug);
  }

  acquire(slug: string): BrainLease<P> {
    if (this.stopped) throw new Error('brain registry is stopped');
    const brain = this.options.brains.get(slug);
    if (!brain) throw new Error(`unknown brain: ${slug}`);
    let entry = this.entries.get(slug);
    if (!entry) {
      if (this.entries.size >= this.options.maxLiveBrains) this.makeRoom();
      entry = { brain, process: this.options.createProcess(brain), inFlight: 0, lastUsedAt: this.options.clock.now() };
      this.entries.set(slug, entry);
    }
    const current = entry;
    current.inFlight += 1;
    current.lastUsedAt = this.options.clock.now();
    let released = false;
    return {
      process: current.process,
      release: () => {
        if (released) return;
        released = true;
        current.inFlight -= 1;
        current.lastUsedAt = this.options.clock.now();
      }
    };
  }

  /** Stops every brain idle for at least the timeout. */
  reap(): void {
    const now = this.options.clock.now();
    for (const [slug, entry] of this.entries) {
      if (entry.inFlight === 0 && now - entry.lastUsedAt >= this.options.idleTimeoutMs) this.evict(slug, 'idle');
    }
  }

  /** Runs `reap()` periodically; the timer never keeps the process alive. */
  startReaper(intervalMs = Math.max(1000, Math.min(30_000, Math.floor(this.options.idleTimeoutMs / 4)))): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => this.reap(), intervalMs);
    this.timer.unref();
  }

  /** Brains with a running child, and how many of those have no request in flight. */
  stats(): { live: number; idle: number } {
    let live = 0;
    let idle = 0;
    for (const entry of this.entries.values()) {
      if (!entry.process.live()) continue;
      live += 1;
      if (entry.inFlight === 0) idle += 1;
    }
    return { live, idle };
  }

  /** Stops one brain's process (the next request starts a new one). */
  async stop(slug: string): Promise<void> {
    const entry = this.entries.get(slug);
    if (!entry) return;
    this.entries.delete(slug);
    await entry.process.close();
  }

  /** Stops every process and refuses further requests (shutdown). */
  async stopAll(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const closing = [...this.entries.keys()].map(slug => this.stop(slug));
    await Promise.allSettled(closing);
  }

  private makeRoom(): void {
    let victim: [string, Entry<P>] | undefined;
    for (const pair of this.entries) {
      if (pair[1].inFlight === 0 && (!victim || pair[1].lastUsedAt < victim[1].lastUsedAt)) victim = pair;
    }
    if (!victim) throw new BrainCapacityError(this.options.maxLiveBrains);
    this.evict(victim[0], 'evicted (MAX_LIVE_BRAINS)');
  }

  private evict(slug: string, reason: string): void {
    this.options.logger.info('Stopping brain process', { brain: slug, reason });
    void this.stop(slug).catch(error => {
      this.options.logger.warn('Brain process did not stop cleanly', { brain: slug, error: (error as Error).message });
    });
  }
}
