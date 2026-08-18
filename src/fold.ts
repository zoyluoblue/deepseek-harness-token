/**
 * The fold: session events → one session's token accounting.
 *
 * Pure and resumable. Pure so it can be unit-tested against fixtures and
 * re-run identically; resumable because the incremental index appends only
 * the frames written since the last pass, and three pieces of mid-log state
 * (`routeKey`, `lastTurn`, `last`) must survive that boundary or a tail refold
 * would silently mis-attribute the first step it sees.
 *
 * Counting discipline (each rule has a source, see DESIGN.md §5):
 *  - The four buckets are DISJOINT; `reasoningTokens` is a subset of output.
 *  - A usage sample arrives twice per step — once as `assistant/chunk`
 *    `{type:'usage'}` during streaming, once on `assistant/message` — so
 *    samples are keyed by (turn, step) and REPLACED, never accumulated.
 *  - Fork children persist the parent's seed verbatim; events below
 *    `header.seedLength` are not ours to count.
 *  - `compaction/summary` carries real spend the upstream `tokenUsage`
 *    projection cannot see; counted by default, switchable for reconciliation.
 *
 * @module @zoytown/dsh-token/fold
 */

import {
  addBuckets,
  totalOf,
  zeroBuckets,
  zeroTally,
  type Buckets,
  type DaySlice,
  type ModelTally,
  type TimeBucket,
} from './types.ts'

/** Bump when the fold's output shape or counting rules change: forces a full rebuild. */
export const FOLD_VERSION = 1

/** Anything before this is clock skew, not history. */
const MIN_EVENT_TIME = Date.UTC(2015, 0, 1)

/** One day of tolerance for a clock that runs ahead. */
const FUTURE_SLACK_MS = 86_400_000

/** Attribution key used when no route has been announced yet. */
export const UNKNOWN_MODEL_KEY = 'unknown/unknown'

/**
 * Structural stand-in for a decoded session event.
 *
 * Deliberately not `SessionEvent` from `@deepseek-ai/dsh-session`: the fold is
 * a pure function that must run in tests over hand-written fixtures, and
 * narrowing a 40-arm discriminated union at every field access buys nothing
 * when every read is already defensive.
 */
export interface EventLike {
  type: string
  seq: number
  time: number
  data?: unknown
}

/** Structural stand-in for the session log's header line. */
export interface HeaderLike {
  version: number
  id: string
  createdAt: number
  cwd?: string
  origin?: string
  parentSession?: string
  delegationDepth?: number
  seedLength?: number
}

/** One session's accounting. Plain JSON — this is what the index persists. */
export interface SessionFold {
  id: string
  /** The `sessionsRoot` this session was read from; part of the index key. */
  home: string
  cwd?: string
  createdAt: number
  /** 'subagent' for a delegated session; absent for top-level and forks. */
  origin?: string
  parentSession?: string
  delegationDepth: number
  seedLength: number
  /** True when the log ended inside an incomplete frame. */
  truncated: boolean
  /** Authoritative session total, including tokens whose timestamps were rejected. */
  totals: Buckets
  /** Subset of `totals.output`; display only. */
  reasoningTokens: number
  /**
   * Authoritative per-model tallies. Kept alongside the per-day slices
   * because a timestamp the skew guard rejected still has a model, and the
   * all-time view must not lose it.
   */
  models: Record<string, ModelTally>
  /** 'YYYY-MM-DD' (local) → that day's slice. */
  days: Record<string, DaySlice>
  firstTime: number | null
  lastTime: number | null
  humanMessages: number
  injectedMessages: number
  assistantMessages: number
  toolResults: number
  turns: number
  steps: number
  usageSamples: number
  stepsWithoutUsage: number
  retriedSteps: number
  compactionCalls: number
}

/** One provider usage report, remembered so a later one for the same step can undo it. */
export interface UsageSample {
  turn: number
  step: number
  key: string
  buckets: Buckets
  reasoning: number
  day: string | null
  hour: number | null
}

/** Mid-log state a resumed fold needs; meaningless on its own. */
export interface FoldCarry {
  /** Last announced `provider/model` route, used when a message carries none. */
  routeKey: string
  /** Turn of the last `step/end`, for turn counting across a resume. */
  lastTurn: number | null
  /** The single live usage slot, per upstream's replace-not-add discipline. */
  last: UsageSample | null
}

/** A fold in progress. */
export interface FoldState {
  fold: SessionFold
  carry: FoldCarry
}

/** Knobs the fold needs from the outside world. */
export interface FoldOptions {
  /** IANA zone for every day and hour bucket. */
  tz: string
  /** Reference "now" for the future-skew guard. */
  now: number
  /**
   * Count `compaction/summary.usage`. Default true: it is real spend the
   * upstream `tokenUsage` projection misses. Set false to reconcile 1:1.
   */
  includeCompaction?: boolean
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Non-negative integer coercion; a malformed count contributes zero, never NaN. */
function count(value: unknown): number {
  const n = asFiniteNumber(value)
  return n !== undefined && n >= 0 ? Math.trunc(n) : 0
}

/** Project a provider usage report onto the four disjoint buckets. */
function bucketsFromUsage(usage: Record<string, unknown>): Buckets {
  return {
    input: count(usage['inputTokens']),
    cacheRead: count(usage['cacheReadTokens']),
    cacheWrite: count(usage['cacheWriteTokens']),
    output: count(usage['outputTokens']),
  }
}

function bucketsEqual(a: Buckets, b: Buckets): boolean {
  return a.input === b.input && a.cacheRead === b.cacheRead
    && a.cacheWrite === b.cacheWrite && a.output === b.output
}

/** Local calendar key for an epoch, or null when the timestamp fails the skew guard. */
export type DayKeyer = (time: number) => { day: string; hour: number } | null

/**
 * Build a local-calendar keyer.
 *
 * Uses `Intl` rather than `Math.floor(ms / 86400000)` because the latter is
 * UTC-based and would put a whole evening's work on the wrong day for most of
 * the world. 'en-CA' is chosen for its ISO-shaped output.
 *
 * @param tz - IANA zone.
 * @param now - reference time for the future-skew guard.
 * @returns a keyer returning null for timestamps outside the plausible window.
 */
export function makeDayKeyer(tz: string, now: number): DayKeyer {
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  })
  return time => {
    if (!Number.isFinite(time) || time < MIN_EVENT_TIME || time > now + FUTURE_SLACK_MS) return null
    const parts = format.formatToParts(time)
    const pick = (type: string): string => parts.find(part => part.type === type)?.value ?? ''
    const hour = Number(pick('hour')) % 24
    if (!Number.isInteger(hour)) return null
    return { day: `${pick('year')}-${pick('month')}-${pick('day')}`, hour }
  }
}

/** The local calendar day of `now`. */
export function todayKey(tz: string, now: number): string {
  return makeDayKeyer(tz, now)(now)?.day ?? new Date(now).toISOString().slice(0, 10)
}

function emptyDaySlice(): DaySlice {
  return {
    tokens: 0,
    messages: 0,
    human: 0,
    tools: 0,
    steps: 0,
    stepsWithoutUsage: 0,
    retriedSteps: 0,
    hours: {},
    models: {},
  }
}

/** Start a fold for one session. */
export function createFoldState(header: HeaderLike, home: string): FoldState {
  return {
    fold: {
      id: header.id,
      home,
      ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
      createdAt: header.createdAt,
      ...(header.origin === undefined ? {} : { origin: header.origin }),
      ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }),
      delegationDepth: header.delegationDepth ?? 0,
      seedLength: header.seedLength ?? 0,
      truncated: false,
      totals: zeroBuckets(),
      reasoningTokens: 0,
      models: {},
      days: {},
      firstTime: null,
      lastTime: null,
      humanMessages: 0,
      injectedMessages: 0,
      assistantMessages: 0,
      toolResults: 0,
      turns: 0,
      steps: 0,
      usageSamples: 0,
      stepsWithoutUsage: 0,
      retriedSteps: 0,
      compactionCalls: 0,
    },
    carry: { routeKey: UNKNOWN_MODEL_KEY, lastTurn: null, last: null },
  }
}

/**
 * Fold a batch of events into an existing state.
 *
 * Safe to call repeatedly with successive batches, which is exactly what the
 * incremental index does: the carry preserves everything a naive restart
 * would lose.
 *
 * @param state - the fold in progress; mutated.
 * @param events - decoded events, in log order.
 * @param options - timezone, reference now, and the compaction switch.
 */
export function foldEvents(
  state: FoldState,
  events: readonly EventLike[],
  options: FoldOptions,
): void {
  const { fold, carry } = state
  const keyer = makeDayKeyer(options.tz, options.now)
  const countCompaction = options.includeCompaction !== false

  const daySlice = (day: string): DaySlice => {
    const existing = fold.days[day]
    if (existing !== undefined) return existing
    const created = emptyDaySlice()
    fold.days[day] = created
    return created
  }
  const hourBucket = (slice: DaySlice, hour: number): TimeBucket => {
    const key = String(hour)
    const existing = slice.hours[key]
    if (existing !== undefined) return existing
    const created: TimeBucket = { tokens: 0, messages: 0 }
    slice.hours[key] = created
    return created
  }

  const tallyInto = (table: Record<string, ModelTally>, sample: UsageSample, sign: 1 | -1): void => {
    const tally = table[sample.key] ?? zeroTally()
    addBuckets(tally.buckets, sample.buckets, sign)
    tally.reasoning += sign * sample.reasoning
    tally.samples += sign
    table[sample.key] = tally
  }

  /** Apply (sign 1) or undo (sign -1) one usage sample everywhere it landed. */
  const applySample = (sample: UsageSample, sign: 1 | -1): void => {
    addBuckets(fold.totals, sample.buckets, sign)
    fold.reasoningTokens += sign * sample.reasoning
    tallyInto(fold.models, sample, sign)
    if (sample.day === null) return
    const slice = daySlice(sample.day)
    const tokens = totalOf(sample.buckets)
    slice.tokens += sign * tokens
    tallyInto(slice.models, sample, sign)
    if (sample.hour !== null) hourBucket(slice, sample.hour).tokens += sign * tokens
  }

  const countMessage = (time: number, human: boolean): void => {
    const key = keyer(time)
    if (key === null) return
    const slice = daySlice(key.day)
    slice.messages += 1
    if (human) slice.human += 1
    hourBucket(slice, key.hour).messages += 1
  }

  /** Bump one day-sliced counter, when the event's timestamp can be placed. */
  const countOnDay = (time: number, field: 'tools' | 'steps' | 'stepsWithoutUsage' | 'retriedSteps'): void => {
    const key = keyer(time)
    if (key === null) return
    daySlice(key.day)[field] += 1
  }

  const noteTime = (time: number): void => {
    if (!Number.isFinite(time) || time < MIN_EVENT_TIME || time > options.now + FUTURE_SLACK_MS) return
    if (fold.firstTime === null || time < fold.firstTime) fold.firstTime = time
    if (fold.lastTime === null || time > fold.lastTime) fold.lastTime = time
  }

  for (const event of events) {
    // Fork children carry the parent's log verbatim below this watermark.
    if (event.seq < fold.seedLength) continue
    noteTime(event.time)
    const data = asRecord(event.data)

    switch (event.type) {
      case 'request/context': {
        const provider = asString(data?.['provider'])
        const model = asString(data?.['model'])
        if (provider !== undefined && model !== undefined) carry.routeKey = `${provider}/${model}`
        break
      }
      case 'request/header': {
        const config = asRecord(asRecord(data?.['header'])?.['config'])
        const provider = asString(config?.['provider'])
        const model = asString(config?.['model'])
        if (provider !== undefined && model !== undefined) carry.routeKey = `${provider}/${model}`
        break
      }
      case 'user/message': {
        if (asString(asRecord(data?.['source'])?.['kind']) === 'user') {
          fold.humanMessages += 1
          countMessage(event.time, true)
        } else {
          fold.injectedMessages += 1
        }
        break
      }
      case 'tool/result': {
        fold.toolResults += 1
        countOnDay(event.time, 'tools')
        break
      }
      case 'step/end': {
        fold.steps += 1
        countOnDay(event.time, 'steps')
        const turn = asFiniteNumber(data?.['turn']) ?? null
        if (carry.lastTurn !== turn) {
          fold.turns += 1
          carry.lastTurn = turn
        }
        const step = asFiniteNumber(data?.['step']) ?? null
        const covered = carry.last !== null && carry.last.turn === turn && carry.last.step === step
        if (!covered) {
          fold.stepsWithoutUsage += 1
          countOnDay(event.time, 'stepsWithoutUsage')
        }
        break
      }
      case 'compaction/summary': {
        fold.compactionCalls += 1
        const usage = asRecord(data?.['usage'])
        if (usage === undefined || !countCompaction) break
        const provider = asString(data?.['provider'])
        const model = asString(data?.['model'])
        const key = keyer(event.time)
        applySample({
          // turn/step -1 keeps this out of the (turn, step) replace slot: a
          // compaction call is its own provider request, never a retry of one.
          turn: -1,
          step: -1,
          key: provider !== undefined && model !== undefined ? `${provider}/${model}` : carry.routeKey,
          buckets: bucketsFromUsage(usage),
          reasoning: count(usage['reasoningTokens']),
          day: key?.day ?? null,
          hour: key?.hour ?? null,
        }, 1)
        fold.usageSamples += 1
        break
      }
      default:
        break
    }

    // --- usage samples -------------------------------------------------
    let turn: number
    let step: number
    let usage: Record<string, unknown>
    let modelKey = carry.routeKey

    if (event.type === 'assistant/chunk') {
      const chunk = asRecord(data?.['chunk'])
      if (asString(chunk?.['type']) !== 'usage') continue
      const reported = asRecord(chunk?.['usage'])
      if (reported === undefined) continue
      turn = asFiniteNumber(data?.['turn']) ?? -1
      step = asFiniteNumber(data?.['step']) ?? -1
      usage = reported
    } else if (event.type === 'assistant/message') {
      const message = asRecord(data?.['message'])
      const source = asRecord(message?.['source'])
      const provider = asString(source?.['provider'])
      const model = asString(source?.['model'])
      // The per-call model beats the announced route: a session may switch.
      if (provider !== undefined && model !== undefined) modelKey = `${provider}/${model}`
      const content = message?.['content']
      // Empty content means the message exists only to host a usage report
      // (e.g. a max-tokens stop), so it is not a message the user saw.
      if (Array.isArray(content) && content.length > 0) {
        fold.assistantMessages += 1
        countMessage(event.time, false)
      }
      const reported = asRecord(data?.['usage'])
      if (reported === undefined) continue
      turn = asFiniteNumber(data?.['turn']) ?? -1
      step = asFiniteNumber(data?.['step']) ?? -1
      usage = reported
    } else {
      continue
    }

    const buckets = bucketsFromUsage(usage)
    const reasoning = count(usage['reasoningTokens'])
    const previous = carry.last !== null && carry.last.turn === turn && carry.last.step === step
      ? carry.last
      : null
    // The routine chunk→message repeat reports identical numbers; skipping it
    // avoids an undo/redo cycle that would only churn the day buckets.
    if (previous !== null && previous.key === modelKey && bucketsEqual(previous.buckets, buckets)) continue

    const key = keyer(event.time)
    const next: UsageSample = {
      turn,
      step,
      key: modelKey,
      buckets,
      reasoning,
      day: key?.day ?? null,
      hour: key?.hour ?? null,
    }
    if (previous !== null) {
      applySample(previous, -1)
      // Different numbers for the same step means an in-step retry happened.
      // The replaced attempt was billed but its value is gone from the log.
      if (!bucketsEqual(previous.buckets, buckets)) {
        fold.retriedSteps += 1
        countOnDay(event.time, 'retriedSteps')
      }
    } else {
      fold.usageSamples += 1
    }
    applySample(next, 1)
    carry.last = next
  }
}

/** Whether a session did anything worth counting as a session. */
export function hasWork(fold: SessionFold): boolean {
  return fold.steps > 0 || fold.humanMessages > 0 || totalOf(fold.totals) > 0
}
