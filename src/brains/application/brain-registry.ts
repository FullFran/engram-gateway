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
 * their brain alive. A brain's process is only created again once its
 * previous child has fully exited (never two children on one data
 * directory), and children still closing count against `maxLiveBrains`.
 */
export class BrainRegistry<P extends BrainProcess> {
  private readonly entries = new Map<string, Entry<P>>();
  /** Brains whose child is shutting down, by slug: settles once it has exited. */
  private readonly closing = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(private readonly options: BrainRegistryOptions<P>) {}

  /** Whether `slug` is a brain this gateway serves. */
  has(slug: string): boolean {
    return this.options.brains.has(slug);
  }

  /**
   * A lease on the brain's process, creating it when needed. Waits while the
   * brain's previous child is closing, or while a slot frees up at capacity;
   * rejects with `BrainCapacityError` when every slot is busy.
   */
  async acquire(slug: string): Promise<BrainLease<P>> {
    for (;;) {
      if (this.stopped) throw new Error('brain registry is stopped');
      const brain = this.options.brains.get(slug);
      if (!brain) throw new Error(`unknown brain: ${slug}`);
      const existing = this.entries.get(slug);
      if (existing) return this.lease(existing);
      const previous = this.closing.get(slug);
      if (previous) {
        await previous;
        continue;
      }
      if (this.entries.size + this.closing.size >= this.options.maxLiveBrains) {
        const victim = this.leastRecentlyUsedIdle();
        if (victim) void this.evict(victim, 'evicted (MAX_LIVE_BRAINS)');
        if (this.closing.size === 0) throw new BrainCapacityError(this.options.maxLiveBrains);
        await Promise.race(this.closing.values());
        continue;
      }
      const entry: Entry<P> = { brain, process: this.options.createProcess(brain), inFlight: 0, lastUsedAt: this.options.clock.now() };
      this.entries.set(slug, entry);
      return this.lease(entry);
    }
  }

  /** Stops every brain idle for at least the timeout; settles once they have exited. */
  async reap(): Promise<void> {
    const now = this.options.clock.now();
    const stopping: Promise<void>[] = [];
    for (const [slug, entry] of this.entries) {
      if (entry.inFlight === 0 && now - entry.lastUsedAt >= this.options.idleTimeoutMs) stopping.push(this.evict(slug, 'idle'));
    }
    await Promise.all(stopping);
  }

  /** Runs `reap()` periodically; the timer never keeps the process alive. */
  startReaper(intervalMs = Math.max(1000, Math.min(30_000, Math.floor(this.options.idleTimeoutMs / 4)))): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.reap(), intervalMs);
    this.timer.unref();
  }

  /** Children running (closing ones included), and how many of those serve no request. */
  stats(): { live: number; idle: number } {
    let live = this.closing.size;
    let idle = this.closing.size;
    for (const entry of this.entries.values()) {
      if (!entry.process.live()) continue;
      live += 1;
      if (entry.inFlight === 0) idle += 1;
    }
    return { live, idle };
  }

  /** Stops one brain's process; settles once its child has exited (the next request starts a new one). */
  async stop(slug: string): Promise<void> {
    const entry = this.entries.get(slug);
    if (!entry) return this.closing.get(slug);
    this.entries.delete(slug);
    const done: Promise<void> = entry.process.close()
      .catch(error => {
        this.options.logger.warn('Brain process did not stop cleanly', { brain: slug, error: (error as Error).message });
      })
      .finally(() => {
        if (this.closing.get(slug) === done) this.closing.delete(slug);
      });
    this.closing.set(slug, done);
    return done;
  }

  /** Stops every process and refuses further requests (shutdown). */
  async stopAll(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const slug of [...this.entries.keys()]) void this.stop(slug);
    await Promise.all([...this.closing.values()]);
  }

  private lease(entry: Entry<P>): BrainLease<P> {
    entry.inFlight += 1;
    entry.lastUsedAt = this.options.clock.now();
    let released = false;
    return {
      process: entry.process,
      release: () => {
        if (released) return;
        released = true;
        entry.inFlight -= 1;
        entry.lastUsedAt = this.options.clock.now();
      }
    };
  }

  private leastRecentlyUsedIdle(): string | undefined {
    let victim: Entry<P> | undefined;
    for (const entry of this.entries.values()) {
      if (entry.inFlight === 0 && (!victim || entry.lastUsedAt < victim.lastUsedAt)) victim = entry;
    }
    return victim?.brain.slug;
  }

  private evict(slug: string, reason: string): Promise<void> {
    this.options.logger.info('Stopping brain process', { brain: slug, reason });
    return this.stop(slug);
  }
}
