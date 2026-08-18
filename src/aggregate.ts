/**
 * Cross-session aggregation and the range window.
 *
 * Two paths on purpose. The all-time view reads each session's authoritative
 * counters, so tokens whose timestamps failed the clock-skew guard are still
 * counted. A bounded range can only be assembled from the day slices, so those
 * tokens necessarily drop out of it — an all-time total may therefore exceed
 * the sum of its days. That is the honest behaviour: a token with an
 * implausible timestamp belongs in a total but not on a calendar.
 *
 * @module @zoytown/dsh-token/aggregate
 */

import { hasWork, todayKey, type SessionFold } from './fold.ts'
import {
  addBuckets,
  addTally,
  totalOf,
  zeroBuckets,
  zeroTally,
  type Buckets,
  type Coverage,
  type ModelTally,
  type ModelUsage,
  type RangeId,
  type TimeBucket,
} from './types.ts'

const DAY_MS = 86_400_000

/** How many days each bounded range covers, today included. */
const RANGE_DAYS: Record<Exclude<RangeId, 'all'>, number> = { '30d': 30, '7d': 7 }

/**
 * Midday UTC anchor for a local calendar day.
 *
 * Adjacency must be tested at noon, not midnight: on a DST transition two
 * consecutive local midnights are 23 or 25 hours apart, which would break a
 * streak that never actually broke. Noon anchors are always exactly one day
 * apart.
 *
 * @param day - 'YYYY-MM-DD'.
 * @returns epoch ms of that day at 12:00 UTC.
 */
export function dayAnchor(day: string): number {
  const [year, month, date] = day.split('-').map(Number)
  return Date.UTC(year ?? 1970, (month ?? 1) - 1, date ?? 1, 12)
}

/** Shift a 'YYYY-MM-DD' key by whole days. */
export function shiftDay(day: string, days: number): string {
  return new Date(dayAnchor(day) + days * DAY_MS).toISOString().slice(0, 10)
}

/** Active-day count and the two streak lengths. */
export interface Streaks {
  active: number
  current: number
  longest: number
}

/**
 * Compute streaks over ascending, de-duplicated day keys.
 *
 * The current streak counts only when it reaches today or yesterday —
 * otherwise a run that ended last month would read as "current".
 *
 * @param sortedDays - ascending 'YYYY-MM-DD' keys, no duplicates.
 * @param today - today's local day key.
 */
export function streaks(sortedDays: readonly string[], today: string): Streaks {
  if (sortedDays.length === 0) return { active: 0, current: 0, longest: 0 }
  let longest = 1
  let run = 1
  for (let i = 1; i < sortedDays.length; i++) {
    const previous = sortedDays[i - 1]
    const day = sortedDays[i]
    if (previous === undefined || day === undefined) continue
    run = dayAnchor(day) - dayAnchor(previous) === DAY_MS ? run + 1 : 1
    if (run > longest) longest = run
  }
  const lastDay = sortedDays[sortedDays.length - 1]
  if (lastDay === undefined) return { active: sortedDays.length, current: 0, longest }
  const gap = dayAnchor(today) - dayAnchor(lastDay)
  let current = 0
  if (gap === 0 || gap === DAY_MS) {
    current = 1
    for (let i = sortedDays.length - 1; i > 0; i--) {
      const previous = sortedDays[i - 1]
      const day = sortedDays[i]
      if (previous === undefined || day === undefined) break
      if (dayAnchor(day) - dayAnchor(previous) !== DAY_MS) break
      current += 1
    }
  }
  return { active: sortedDays.length, current, longest }
}

/**
 * Same session id under two homes (a copied directory) is one session.
 * Keeps the copy that saw the most activity.
 */
export function dedupeFolds(folds: readonly SessionFold[]): SessionFold[] {
  const best = new Map<string, SessionFold>()
  for (const fold of folds) {
    const previous = best.get(fold.id)
    if (previous === undefined) {
      best.set(fold.id, fold)
      continue
    }
    const newer = (fold.lastTime ?? 0) > (previous.lastTime ?? 0)
    const richer = (fold.lastTime ?? 0) === (previous.lastTime ?? 0) && fold.steps > previous.steps
    if (newer || richer) best.set(fold.id, fold)
  }
  return [...best.values()]
}

/** Everything a summary needs, before it is dressed for the wire. */
export interface AggregateResult {
  sessions: number
  subagentSessions: number
  messages: number
  surfaceMessages: number
  humanMessages: number
  assistantMessages: number
  toolResults: number
  totals: Buckets
  totalTokens: number
  reasoningTokens: number
  activeDays: number
  currentStreak: number
  longestStreak: number
  peakHour: number | null
  favoriteModel: string | null
  days: Record<string, TimeBucket>
  hours: TimeBucket[]
  models: ModelUsage[]
  coverage: Omit<Coverage, 'skippedArtifacts'>
}

function emptyHours(): TimeBucket[] {
  return Array.from({ length: 24 }, () => ({ tokens: 0, messages: 0 }))
}

function toModelUsage(table: Map<string, ModelTally>): ModelUsage[] {
  const rows: ModelUsage[] = []
  for (const [key, tally] of table) {
    const slash = key.indexOf('/')
    rows.push({
      key,
      provider: slash < 0 ? key : key.slice(0, slash),
      model: slash < 0 ? key : key.slice(slash + 1),
      buckets: tally.buckets,
      reasoning: tally.reasoning,
      samples: tally.samples,
      total: totalOf(tally.buckets),
    })
  }
  rows.sort((a, b) => (b.total - a.total) || (b.samples - a.samples) || a.key.localeCompare(b.key))
  return rows
}

/**
 * Aggregate folded sessions into one summary body.
 *
 * @param input - one fold per session artifact; duplicates across homes are removed here.
 * @param range - 'all' uses authoritative counters; bounded ranges use day slices.
 * @param tz - IANA zone the day keys were built with.
 * @param now - reference time, used for the range window and the current streak.
 */
export function aggregate(
  input: readonly SessionFold[],
  range: RangeId,
  tz: string,
  now: number,
): AggregateResult {
  const today = todayKey(tz, now)
  const cutoff = range === 'all' ? undefined : shiftDay(today, -(RANGE_DAYS[range] - 1))
  const inRange = (day: string): boolean => cutoff === undefined || day >= cutoff

  const folds = dedupeFolds(input).filter(hasWork)
  const totals = zeroBuckets()
  const models = new Map<string, ModelTally>()
  const days: Record<string, TimeBucket> = {}
  const hours = emptyHours()
  let reasoningTokens = 0
  let sessions = 0
  let subagentSessions = 0
  let humanMessages = 0
  let assistantMessages = 0
  let toolResults = 0
  let messages = 0
  let steps = 0
  let stepsWithoutUsage = 0
  let retriedSteps = 0
  let truncatedSessions = 0

  const tallyFor = (key: string): ModelTally => {
    const existing = models.get(key)
    if (existing !== undefined) return existing
    const created = zeroTally()
    models.set(key, created)
    return created
  }

  for (const fold of folds) {
    const dayKeys = Object.keys(fold.days).filter(inRange)
    // A bounded range only contains sessions that were active inside it.
    if (cutoff !== undefined && dayKeys.length === 0) continue

    if (fold.origin === 'subagent') subagentSessions += 1
    else sessions += 1
    if (fold.truncated) truncatedSessions += 1

    // All-time reads the authoritative session counters, so events whose
    // timestamps the skew guard rejected are still counted somewhere.
    if (cutoff === undefined) {
      addBuckets(totals, fold.totals)
      reasoningTokens += fold.reasoningTokens
      for (const [key, tally] of Object.entries(fold.models)) addTally(tallyFor(key), tally)
      humanMessages += fold.humanMessages
      assistantMessages += fold.assistantMessages
      toolResults += fold.toolResults
      steps += fold.steps
      stepsWithoutUsage += fold.stepsWithoutUsage
      retriedSteps += fold.retriedSteps
    }

    for (const day of dayKeys) {
      const slice = fold.days[day]
      if (slice === undefined) continue
      const bucket = days[day] ?? { tokens: 0, messages: 0 }
      bucket.tokens += slice.tokens
      bucket.messages += slice.messages
      days[day] = bucket
      for (const [hourKey, activity] of Object.entries(slice.hours)) {
        const hour = hours[Number(hourKey)]
        if (hour === undefined) continue
        hour.tokens += activity.tokens
        hour.messages += activity.messages
      }
      if (cutoff === undefined) continue
      // Bounded range: every counter comes from the day slices, so the window
      // is a real sum rather than whole sessions attributed to it.
      humanMessages += slice.human
      assistantMessages += slice.messages - slice.human
      toolResults += slice.tools
      steps += slice.steps
      stepsWithoutUsage += slice.stepsWithoutUsage
      retriedSteps += slice.retriedSteps
      for (const [key, tally] of Object.entries(slice.models)) {
        addTally(tallyFor(key), tally)
        addBuckets(totals, tally.buckets)
        reasoningTokens += tally.reasoning
      }
    }
  }
  messages = humanMessages + assistantMessages

  const activeDayKeys = Object.entries(days)
    .filter(([, bucket]) => bucket.tokens > 0 || bucket.messages > 0)
    .map(([day]) => day)
    .sort()
  const streak = streaks(activeDayKeys, today)

  let peakHour: number | null = null
  for (let hour = 0; hour < 24; hour++) {
    const candidate = hours[hour]
    if (candidate === undefined) continue
    if (candidate.messages === 0 && candidate.tokens === 0) continue
    const best = peakHour === null ? undefined : hours[peakHour]
    if (best === undefined
      || candidate.messages > best.messages
      || (candidate.messages === best.messages && candidate.tokens > best.tokens)) {
      peakHour = hour
    }
  }

  const modelRows = toModelUsage(models).filter(row => row.key !== 'unknown/unknown' || row.total > 0)
  const ranked = modelRows.filter(row => row.key !== 'unknown/unknown')
  const favoriteModel = ranked[0]?.key ?? null

  return {
    sessions,
    subagentSessions,
    messages,
    surfaceMessages: messages + toolResults,
    humanMessages,
    assistantMessages,
    toolResults,
    totals,
    totalTokens: totalOf(totals),
    reasoningTokens,
    activeDays: streak.active,
    currentStreak: streak.current,
    longestStreak: streak.longest,
    peakHour,
    favoriteModel,
    days,
    hours,
    models: modelRows,
    coverage: { steps, stepsWithoutUsage, retriedSteps, truncatedSessions },
  }
}
