/**
 * The incremental index: every session on this machine, folded once.
 *
 * A full scan is not viable on the read path. Measured on this class of
 * machine, folding 1,200 sessions / 319 MB of compressed logs takes ~4 s, and
 * the cost is frame-bound rather than byte-bound (one frame per durable append
 * batch, ~2-7 µs of fixed overhead each) — so it does not shrink with a faster
 * decompressor. The index therefore folds once in the background and after
 * that only reads the bytes appended since.
 *
 * Freshness is decided by (dev, ino, size, mtimeMs). Append-only logs make the
 * tail read sound; the three cases that are NOT appends (inode swap from an
 * atomic republish, a shrink from torn-tail repair, a backwards mtime) each
 * force that one session to be refolded from zero.
 *
 * @module @zoytown/dsh-token/index-store
 */

import {
  createFoldState,
  foldEvents,
  FOLD_VERSION,
  type FoldCarry,
  type HeaderLike,
  type SessionFold,
} from './fold.ts'
import { aggregate } from './aggregate.ts'
import { discoverDshHomes, type DshHome } from './homes.ts'
import { readArtifact, walkSessionArtifacts } from './reader.ts'
import type { HomeInfo, IndexStatus, RangeId, TokenSummary } from './types.ts'

/** How many records the cursor table is sharded across. */
export const SHARD_COUNT = 32

/** One indexed session: the freshness witness, the fold, and its resume state. */
export interface IndexEntry {
  /** Absolute artifact path. */
  path: string
  size: number
  mtimeMs: number
  ino: number
  dev: number
  /** Byte offset just past the last complete frame consumed. */
  cursor: number
  header: HeaderLike
  fold: SessionFold
  /** Mid-log state; a tail refold without this would mis-attribute its first step. */
  carry: FoldCarry
}

/** Index-wide facts that invalidate every entry when they change. */
export interface IndexMeta {
  /** IANA zone the day keys were built with. */
  tz: string
  /** {@link FOLD_VERSION} the entries were produced by. */
  foldVersion: number
  /** Epoch ms of the last completed refresh. */
  builtAt: number
}

/**
 * Durable store for the index. Optional by design: `storageDomain` is mounted
 * only by the web-app bundle, and a missing one must degrade to a memory-only
 * index rather than leaving the plugin — and its settings tab — unloadable.
 */
export interface IndexPersistence {
  load(): Promise<{ meta: IndexMeta; entries: Map<string, IndexEntry> } | undefined>
  /** Persist the named shards, replacing each one wholesale. */
  saveShards(shards: ReadonlyMap<string, Record<string, IndexEntry>>): Promise<void>
  saveMeta(meta: IndexMeta): Promise<void>
  /** Drop everything (a meta mismatch, or a corrupt medium). */
  clear(): Promise<void>
}

/** Tunables the store needs; all sourced from the plugin config. */
export interface IndexStoreOptions {
  /** Additional home directories the discovery heuristic cannot find. */
  extraSessionRoots: readonly string[]
  /** Count `compaction/summary.usage` in totals. */
  includeCompaction: boolean
  /** Cooperative yield interval during a scan, in ms. */
  chunkYieldMs: number
  /** The home this process is running against. */
  currentHome: string
  /** OS home directory the discovery heuristic hangs off; injectable for tests. */
  osHome?: string
  /** Injectable clock; tests pin it. */
  now?: () => number
}

const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

function fnv1a(input: string): number {
  let hash = FNV_OFFSET
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, FNV_PRIME) >>> 0
  }
  return hash
}

/**
 * Shard a session key.
 *
 * Sharding is about write count, not size: the JSON backend republishes a
 * whole unit file per `put`, measured at ~10 ms regardless of size, so 1,200
 * per-session writes would cost ~12 s. Thirty-two fat records cost ~0.3 s.
 *
 * @param key - the session's index key.
 * @returns the shard record name, 'c00'..'c1f'.
 */
export function shardOf(key: string): string {
  return `c${(fnv1a(key) % SHARD_COUNT).toString(16).padStart(2, '0')}`
}

/** Resolve the local IANA zone, falling back to UTC on a stripped-down ICU build. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

interface HomeTally {
  info: HomeInfo
  home: DshHome
}

/**
 * Owns the folded index and answers summary queries.
 *
 * Single-writer: concurrent `refresh()` calls share one pass. The store never
 * throws out of `refresh()` — a scan failure is reported through `status`, so
 * a transient filesystem problem degrades the panel instead of the plugin.
 */
export class TokenIndexStore {
  private readonly entries = new Map<string, IndexEntry>()
  private readonly options: IndexStoreOptions
  private readonly now: () => number
  private persistence: IndexPersistence | undefined
  private meta: IndexMeta
  private running: Promise<void> | undefined
  private disposed = false
  private homeInfos: HomeInfo[] = []
  private skippedArtifacts = 0
  private state: IndexStatus

  constructor(options: IndexStoreOptions) {
    this.options = options
    this.now = options.now ?? (() => Date.now())
    this.meta = { tz: localTimeZone(), foldVersion: FOLD_VERSION, builtAt: 0 }
    this.state = {
      phase: 'idle',
      indexed: 0,
      total: 0,
      durable: false,
      updatedAt: null,
    }
  }

  /** Current build phase and progress. */
  get status(): IndexStatus {
    return { ...this.state }
  }

  /** Stop the in-flight scan and refuse further work. */
  dispose(): void {
    this.disposed = true
  }

  /**
   * Attach a durable store and adopt whatever it already holds.
   *
   * A meta mismatch (timezone moved, fold rules changed) discards the medium
   * rather than migrating it: the entries are derived data, and a wrong day
   * bucket is worse than a slow rebuild.
   *
   * @param persistence - the durable port.
   */
  async attach(persistence: IndexPersistence): Promise<void> {
    this.persistence = persistence
    this.state = { ...this.state, durable: true }
    const stored = await persistence.load()
    if (stored === undefined) return
    if (stored.meta.tz !== this.meta.tz || stored.meta.foldVersion !== FOLD_VERSION) {
      await persistence.clear()
      return
    }
    for (const [key, entry] of stored.entries) this.entries.set(key, entry)
    this.meta = stored.meta
    this.state = {
      ...this.state,
      phase: this.entries.size > 0 ? 'ready' : 'idle',
      indexed: this.entries.size,
      total: this.entries.size,
      updatedAt: stored.meta.builtAt > 0 ? stored.meta.builtAt : null,
    }
  }

  /** Detach the durable store; the index keeps working from memory. */
  detach(): void {
    this.persistence = undefined
    this.state = { ...this.state, durable: false }
  }

  /**
   * Bring the index up to date.
   *
   * Concurrent callers join the running pass rather than starting a second
   * one — two scanners would fight over the same shard records.
   */
  refresh(): Promise<void> {
    if (this.running !== undefined) return this.running
    const pass = this.scan().finally(() => {
      this.running = undefined
    })
    this.running = pass
    return pass
  }

  /**
   * Build a summary from what the index currently holds.
   *
   * Deliberately synchronous and independent of `refresh()`: the panel renders
   * partial results during the first build instead of blocking on it.
   *
   * @param range - the window to report.
   */
  summarize(range: RangeId): TokenSummary {
    const now = this.now()
    const folds = [...this.entries.values()].map(entry => entry.fold)
    const result = aggregate(folds, range, this.meta.tz, now)
    return {
      version: 1,
      generatedAt: now,
      tz: this.meta.tz,
      range,
      status: this.status,
      sessions: result.sessions,
      subagentSessions: result.subagentSessions,
      messages: result.messages,
      surfaceMessages: result.surfaceMessages,
      humanMessages: result.humanMessages,
      assistantMessages: result.assistantMessages,
      toolResults: result.toolResults,
      totals: result.totals,
      totalTokens: result.totalTokens,
      reasoningTokens: result.reasoningTokens,
      activeDays: result.activeDays,
      currentStreak: result.currentStreak,
      longestStreak: result.longestStreak,
      peakHour: result.peakHour,
      favoriteModel: result.favoriteModel,
      days: result.days,
      hours: result.hours,
      models: result.models,
      homes: this.homeInfos,
      coverage: { ...result.coverage, skippedArtifacts: this.skippedArtifacts },
    }
  }

  private async scan(): Promise<void> {
    if (this.disposed) return
    // Only the FIRST pass is a "build". Later passes are incremental and
    // almost always no-ops, so reporting them as building would leave the
    // panel showing a progress bar that never settles.
    const firstBuild = this.state.phase !== 'ready'
    if (firstBuild) this.state = { ...this.state, phase: 'building', indexed: 0, total: 0 }
    this.skippedArtifacts = 0
    const dirtyShards = new Set<string>()
    const seen = new Set<string>()
    let lastYield = this.now()
    let discovered = 0
    let processed = 0
    /** Progress is only meaningful — and only published — during a build. */
    const publishProgress = (): void => {
      if (firstBuild) this.state = { ...this.state, indexed: processed, total: discovered }
    }

    try {
      const discovery = await discoverDshHomes({
        currentHome: this.options.currentHome,
        extraRoots: this.options.extraSessionRoots,
        ...(this.options.osHome === undefined ? {} : { osHome: this.options.osHome }),
      })
      const tallies: HomeTally[] = discovery.homes.map(home => ({
        home,
        info: { home: home.home, current: home.current, sessions: 0 },
      }))
      const infos: HomeInfo[] = tallies.map(tally => tally.info)
      for (const problem of discovery.problems) {
        infos.push({ home: problem.home, current: false, sessions: 0, error: problem.error })
      }
      this.homeInfos = infos

      for (const tally of tallies) {
        for await (const artifact of walkSessionArtifacts(tally.home)) {
          if (this.disposed) return
          seen.add(artifact.key)
          tally.info.sessions += 1
          discovered += 1
          publishProgress()

          const previous = this.entries.get(artifact.key)
          const unchanged = previous !== undefined
            && previous.size === artifact.size
            && previous.mtimeMs === artifact.mtimeMs
            && previous.ino === artifact.ino
            && previous.dev === artifact.dev
          if (unchanged) {
            processed += 1
            publishProgress()
            continue
          }

          // An inode swap, a shrink, or a backwards clock all mean the bytes
          // we already consumed are no longer the bytes on disk.
          const resumable = previous !== undefined
            && previous.ino === artifact.ino
            && previous.dev === artifact.dev
            && artifact.size >= previous.cursor
            && artifact.mtimeMs >= previous.mtimeMs
          const updated = await this.foldArtifact(artifact, resumable ? previous : undefined)
          if (updated === undefined) {
            this.skippedArtifacts += 1
          } else {
            this.entries.set(artifact.key, updated)
            dirtyShards.add(shardOf(artifact.key))
          }
          processed += 1
          publishProgress()

          const now = this.now()
          if (now - lastYield >= this.options.chunkYieldMs) {
            lastYield = now
            await new Promise<void>(resolve => { setImmediate(resolve) })
          }
        }
      }

      for (const key of [...this.entries.keys()]) {
        if (seen.has(key)) continue
        this.entries.delete(key)
        dirtyShards.add(shardOf(key))
      }

      this.meta = { ...this.meta, builtAt: this.now() }
      this.state = {
        ...this.state,
        phase: 'ready',
        indexed: this.entries.size,
        total: this.entries.size,
        updatedAt: this.meta.builtAt,
      }
      await this.persist(dirtyShards)
    } catch (error) {
      // A failed incremental pass keeps whatever the last good one produced;
      // the panel shows the message beside real numbers rather than instead
      // of them.
      this.state = {
        ...this.state,
        phase: 'error',
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * Fold one artifact, resuming from `previous` when the bytes only grew.
   * @returns the updated entry, or undefined when the artifact is unreadable
   * or written in a format version this build cannot interpret.
   */
  private async foldArtifact(
    artifact: { path: string; size: number; mtimeMs: number; ino: number; dev: number; home: DshHome },
    previous: IndexEntry | undefined,
  ): Promise<IndexEntry | undefined> {
    try {
      const read = await readArtifact(artifact.path, previous?.cursor ?? 0, previous?.header)
      if (read.foreign) return undefined
      const state = previous === undefined
        ? createFoldState(read.header, artifact.home.sessionsRoot)
        : { fold: previous.fold, carry: previous.carry }
      foldEvents(state, read.events, {
        tz: this.meta.tz,
        now: this.now(),
        includeCompaction: this.options.includeCompaction,
      })
      state.fold.truncated = read.torn
      return {
        path: artifact.path,
        size: artifact.size,
        mtimeMs: artifact.mtimeMs,
        ino: artifact.ino,
        dev: artifact.dev,
        cursor: read.cursor,
        header: read.header,
        fold: state.fold,
        carry: state.carry,
      }
    } catch {
      // One unreadable or corrupt log must not cost the user every other
      // session; it is counted and surfaced as `skippedArtifacts` instead.
      return undefined
    }
  }

  private async persist(dirtyShards: ReadonlySet<string>): Promise<void> {
    const persistence = this.persistence
    if (persistence === undefined || dirtyShards.size === 0) return
    const shards = new Map<string, Record<string, IndexEntry>>()
    for (const shard of dirtyShards) shards.set(shard, {})
    for (const [key, entry] of this.entries) {
      const shard = shards.get(shardOf(key))
      if (shard !== undefined) shard[key] = entry
    }
    try {
      await persistence.saveShards(shards)
      await persistence.saveMeta(this.meta)
    } catch (error) {
      // Losing durability costs a rebuild next boot, never correctness.
      this.state = {
        ...this.state,
        durable: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }
}
