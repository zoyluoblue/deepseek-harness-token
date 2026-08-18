/**
 * Wire types shared by the host half and the browser half.
 *
 * This module is the transport contract. It imports nothing — the browser
 * bundle inlines it, and keeping it dependency-free is what lets the two
 * halves stay type-safe without a code generator.
 *
 * @module @zoytown/dsh-token/types
 */

/**
 * The four DISJOINT provider-reported token buckets.
 *
 * Upstream states the disjointness explicitly (dsh-llm `src/types.ts:127-141`:
 * "Counts are DISJOINT ... billed input = sum of the three"), which is what
 * makes summing them a total rather than a double count. `reasoningTokens` is
 * deliberately absent: it is a SUBSET of `output` and is carried separately
 * for display only.
 */
export interface Buckets {
  /** Fresh (uncached) prompt tokens. */
  input: number
  /** Prompt tokens served from the provider's cache. */
  cacheRead: number
  /** Prompt tokens written into the provider's cache. */
  cacheWrite: number
  /** Completion tokens, reasoning included. */
  output: number
}

/** Activity in one time bucket (a local day, or one local hour of it). */
export interface TimeBucket {
  /** Total tokens across all four buckets. */
  tokens: number
  /** Human + non-empty assistant messages. */
  messages: number
}

/** Tokens attributed to one model, at any level of aggregation. */
export interface ModelTally {
  buckets: Buckets
  /** Subset of `buckets.output`; display only. */
  reasoning: number
  /** Number of provider usage samples that landed here. */
  samples: number
}

/**
 * One local calendar day of a single session.
 *
 * Every counter the UI can show for a bounded range lives here, so a 7-day
 * view is a real sum rather than whole-session values attributed to a window
 * the session merely touched.
 */
export interface DaySlice extends TimeBucket {
  /** Human messages; `messages - human` is the assistant share. */
  human: number
  /** Tool results, kept out of `messages` and added only into the surface count. */
  tools: number
  /** Model steps that ended on this day. */
  steps: number
  /** Of those, steps that left no provider usage sample. */
  stepsWithoutUsage: number
  /** Of those, steps whose usage sample was replaced by a differing one. */
  retriedSteps: number
  /** Local hour ('0'..'23') → activity. Sparse: absent hours had none. */
  hours: Record<string, TimeBucket>
  /** `provider/model` → tokens attributed to that model on this day. */
  models: Record<string, ModelTally>
}

/** Per-model rollup as presented to the UI. */
export interface ModelUsage {
  /** `provider/model`, the attribution key. */
  key: string
  provider: string
  model: string
  buckets: Buckets
  /** Subset of `buckets.output`; display only. */
  reasoning: number
  /** Number of usage samples attributed to this model. */
  samples: number
  /** Sum of the four buckets. */
  total: number
}

/** One dsh home the index scanned. */
export interface HomeInfo {
  /** The home directory as discovered (e.g. `~/.dsh_desktop/0.1.0-rc.6`). */
  home: string
  /** True for the home this process itself is running against. */
  current: boolean
  /** Sessions found under this home. */
  sessions: number
  /** Set when the home was found but could not be read (e.g. EACCES). */
  error?: string
}

/** Facts the UI must disclose rather than silently absorb. */
export interface Coverage {
  /** Total model steps observed. */
  steps: number
  /** Steps that left no provider usage sample — the honest denominator. */
  stepsWithoutUsage: number
  /**
   * Steps where a second, DIFFERENT usage sample replaced an earlier one.
   * The replaced attempt was billed but its numbers are not recoverable from
   * the log, so totals under-count by that much.
   */
  retriedSteps: number
  /** Sessions whose log ended inside an incomplete frame. */
  truncatedSessions: number
  /** Artifacts skipped entirely (unreadable, or a foreign format version). */
  skippedArtifacts: number
}

/** Index build phase, surfaced so the panel never lies about being complete. */
export type IndexPhase = 'idle' | 'building' | 'ready' | 'error'

/** Progress and durability of the host-side index. */
export interface IndexStatus {
  phase: IndexPhase
  /** Sessions folded so far. */
  indexed: number
  /** Sessions discovered; equals `indexed` once `phase` is 'ready'. */
  total: number
  /** False when `storageDomain` is unavailable and the index is memory-only. */
  durable: boolean
  /** Epoch ms of the last completed refresh, or null before the first one. */
  updatedAt: number | null
  /** Operator-facing detail; present when `phase` is 'error'. */
  message?: string
}

/** Time window the summary covers. */
export type RangeId = 'all' | '30d' | '7d'

/** Everything the panel renders. Produced by the host, consumed by the browser. */
export interface TokenSummary {
  /** Wire schema version; the client refuses a value it does not know. */
  version: 1
  generatedAt: number
  /** IANA zone used for every day/hour bucket. */
  tz: string
  range: RangeId
  status: IndexStatus

  /** Top-level sessions with work. Excludes subagent sessions. */
  sessions: number
  /** Subagent sessions, shown as a subtitle; their tokens ARE in the totals. */
  subagentSessions: number
  /** Headline message count: human + non-empty assistant. */
  messages: number
  /** messages + tool results + injected messages. Never `events.length`. */
  surfaceMessages: number
  humanMessages: number
  assistantMessages: number
  toolResults: number

  totals: Buckets
  /** Sum of the four buckets — includes cacheRead by decision D2. */
  totalTokens: number
  /** Subset of `totals.output`; display only. */
  reasoningTokens: number

  activeDays: number
  currentStreak: number
  longestStreak: number
  /** Local hour 0-23 with the most messages, or null when there is no data. */
  peakHour: number | null
  /** `provider/model` with the most tokens, or null. */
  favoriteModel: string | null

  /** 'YYYY-MM-DD' (local) → activity. Only days inside `range`. */
  days: Record<string, TimeBucket>
  /** Length 24, indexed by local hour. */
  hours: TimeBucket[]
  /** Sorted by total tokens, descending. */
  models: ModelUsage[]

  homes: HomeInfo[]
  coverage: Coverage
}

/** Failure envelope returned by the transport on a non-200. */
export interface TokenSummaryError {
  error: string
}

/** Zeroed buckets. */
export function zeroBuckets(): Buckets {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
}

/** Zeroed model tally. */
export function zeroTally(): ModelTally {
  return { buckets: zeroBuckets(), reasoning: 0, samples: 0 }
}

/** Add (or subtract) one tally into another in place. */
export function addTally(target: ModelTally, source: ModelTally, sign: 1 | -1 = 1): void {
  addBuckets(target.buckets, source.buckets, sign)
  target.reasoning += sign * source.reasoning
  target.samples += sign * source.samples
}

/** Sum of the four disjoint buckets. Decision D2: cacheRead is included. */
export function totalOf(buckets: Buckets): number {
  return buckets.input + buckets.cacheRead + buckets.cacheWrite + buckets.output
}

/** Add (or, with `sign` -1, subtract) `source` into `target` in place. */
export function addBuckets(target: Buckets, source: Buckets, sign: 1 | -1 = 1): void {
  target.input += sign * source.input
  target.cacheRead += sign * source.cacheRead
  target.cacheWrite += sign * source.cacheWrite
  target.output += sign * source.output
}
