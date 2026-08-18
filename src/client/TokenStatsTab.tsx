/**
 * The Token settings page, mounted into `settings.section`.
 *
 * It owns its own heading: the shell renders a section body with no chrome
 * around it, so a page without one reads as content that lost its title.
 *
 * Two runtime facts shape the refresh loop:
 *  - Nothing persists. The dialog and its active section are component-local
 *    state, and closing resets the selection, so every open re-mounts and
 *    re-fetches. The cache lives on the host, never here.
 *  - The page can be off-screen while still mounted, so the poll checks
 *    visibility rather than assuming unmount.
 *
 * @module @zoytown/dsh-token/client/TokenStatsTab
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RangeId, TokenSummary } from '../types.ts'
import { compactNumber, exactNumber, formatHour, percent, shortModel } from './format.ts'
import { Heatmap } from './Heatmap.tsx'
import { interpolate } from './locales.ts'
import { ModelBars } from './ModelBars.tsx'
import { fetchSummary, type TokenStatsSource } from './source.ts'
import type { Translate } from './runtime.d.ts'
import css from './TokenStatsTab.module.css'

/** Poll cadence while the tab is on screen and the host is still indexing. */
const BUILDING_POLL_MS = 1500

/** Poll cadence once the index is settled. */
const IDLE_POLL_MS = 30_000

type View = 'overview' | 'models'

const VIEWS: readonly { id: View; label: string }[] = [
  { id: 'overview', label: 'view.overview' },
  { id: 'models', label: 'view.models' },
]

const RANGES: readonly { id: RangeId; label: string }[] = [
  { id: 'all', label: 'range.all' },
  { id: '30d', label: 'range.30d' },
  { id: '7d', label: 'range.7d' },
]

export interface TokenStatsTabProps {
  /** Injected by the slot's `locale` declaration. */
  t: Translate
  /** Overridable for tests and for a future transport swap. */
  source?: TokenStatsSource
}

interface Loaded {
  summary: TokenSummary | undefined
  error: string | undefined
  loading: boolean
}

function relativeWhen(t: Translate, at: number | null, now: number): string {
  if (at === null) return t('when.never')
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return t('when.now')
  if (minutes < 60) return interpolate(t('when.minutes'), { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return interpolate(t('when.hours'), { n: hours })
  return interpolate(t('when.days'), { n: Math.floor(hours / 24) })
}

function StatCard(props: { label: string; value: string; hint?: string; title?: string }): JSX.Element {
  return (
    <div className={css.statCard}>
      <span className={css.statLabel}>{props.label}</span>
      <span className={css.statValue} title={props.title ?? props.value}>{props.value}</span>
      <span className={css.statHint}>{props.hint ?? ' '}</span>
    </div>
  )
}

function Segmented<T extends string>(props: {
  label: string
  options: readonly { id: T; label: string }[]
  value: T
  onChange: (next: T) => void
  t: Translate
}): JSX.Element {
  return (
    <div className={css.segmented} role="radiogroup" aria-label={props.label}>
      {props.options.map(option => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={option.id === props.value}
          className={css.segment}
          onClick={() => { props.onChange(option.id) }}
        >
          {props.t(option.label)}
        </button>
      ))}
    </div>
  )
}

/** Token usage statistics for every dsh home on this machine. */
export function TokenStatsTab({ t, source = fetchSummary }: TokenStatsTabProps): JSX.Element {
  const [view, setView] = useState<View>('overview')
  const [range, setRange] = useState<RangeId>('all')
  const [state, setState] = useState<Loaded>({ summary: undefined, error: undefined, loading: true })
  const [reloadToken, setReloadToken] = useState(0)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const retry = useCallback(() => {
    setState(current => ({ ...current, loading: true, error: undefined }))
    setReloadToken(token => token + 1)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancelled = false

    const load = async (): Promise<void> => {
      try {
        const summary = await source(range, controller.signal)
        if (cancelled) return
        setState({ summary, error: undefined, loading: false })
        schedule(summary.status.phase === 'building' ? BUILDING_POLL_MS : IDLE_POLL_MS)
      } catch (error) {
        if (cancelled || controller.signal.aborted) return
        setState(current => ({
          summary: current.summary,
          error: error instanceof Error ? error.message : String(error),
          loading: false,
        }))
        schedule(IDLE_POLL_MS)
      }
    }

    const schedule = (delay: number): void => {
      timer = setTimeout(() => {
        // A hidden tab stays mounted; `offsetParent` is null under
        // `display: none`, which is the cheapest reliable visibility probe
        // available without owning a subscription.
        if (rootRef.current?.offsetParent === null || document.hidden) {
          schedule(delay)
          return
        }
        void load()
      }, delay)
    }

    void load()
    return () => {
      cancelled = true
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [range, reloadToken, source])

  const { summary, error, loading } = state
  const now = summary?.generatedAt ?? Date.now()

  const cards = useMemo(() => {
    if (summary === undefined) return []
    return [
      {
        label: t('stat.sessions'),
        value: exactNumber(summary.sessions),
        hint: summary.subagentSessions > 0
          ? interpolate(t('stat.sessions.subagents'), { n: summary.subagentSessions })
          : undefined,
      },
      { label: t('stat.messages'), value: exactNumber(summary.messages) },
      {
        label: t('stat.tokens'),
        value: compactNumber(summary.totalTokens),
        title: exactNumber(summary.totalTokens),
        hint: t('note.cacheIncluded'),
      },
      { label: t('stat.activeDays'), value: exactNumber(summary.activeDays) },
      { label: t('stat.currentStreak'), value: `${summary.currentStreak}${t('unit.days')}` },
      { label: t('stat.longestStreak'), value: `${summary.longestStreak}${t('unit.days')}` },
      {
        label: t('stat.peakHour'),
        value: formatHour(summary.peakHour, t('stat.peakHour.pattern'), t('time.am'), t('time.pm')),
      },
      {
        label: t('stat.favoriteModel'),
        value: shortModel(summary.favoriteModel),
        title: summary.favoriteModel ?? undefined,
      },
    ]
  }, [summary, t])

  const footer = useMemo(() => {
    if (summary === undefined) return []
    const items: string[] = []
    const homes = summary.homes.filter(home => home.error === undefined).length
    items.push(interpolate(t(homes === 1 ? 'footer.homes' : 'footer.homes.plural'), { n: homes }))
    items.push(interpolate(t('footer.updated'), {
      when: relativeWhen(t, summary.status.updatedAt, now),
    }))
    if (!summary.status.durable) items.push(t('footer.memoryOnly'))
    if (summary.coverage.steps > 0 && summary.coverage.stepsWithoutUsage > 0) {
      items.push(interpolate(t('footer.coverage'), {
        percent: percent(summary.coverage.steps - summary.coverage.stepsWithoutUsage, summary.coverage.steps),
      }))
    }
    if (summary.coverage.retriedSteps > 0) {
      items.push(interpolate(t('footer.retried'), { n: summary.coverage.retriedSteps }))
    }
    if (summary.coverage.truncatedSessions > 0) {
      items.push(interpolate(t('footer.truncated'), { n: summary.coverage.truncatedSessions }))
    }
    if (summary.coverage.skippedArtifacts > 0) {
      items.push(interpolate(t('footer.skipped'), { n: summary.coverage.skippedArtifacts }))
    }
    return items
  }, [summary, now, t])

  const body = ((): JSX.Element => {
    if (summary === undefined && loading) {
      return (
        <>
          <div className={css.progress}>{t('state.loading')}</div>
          <div className={css.skeletonGrid}>
            {[0, 1, 2, 3, 4, 5, 6, 7].map(index => <div key={index} className={css.skeleton} />)}
          </div>
          <div className={css.skeletonStrip} />
        </>
      )
    }
    if (summary === undefined) {
      return (
        <div className={`${css.message} ${css.messageError}`} role="alert">
          <span className={css.messageTitle}>{t('state.error.title')}</span>
          <span className={css.messageBody}>{error ?? ''}</span>
          <button type="button" className={css.retry} onClick={retry}>{t('state.retry')}</button>
        </div>
      )
    }
    if (summary.sessions === 0 && summary.subagentSessions === 0 && summary.status.phase !== 'building') {
      return (
        <div className={css.message}>
          <span className={css.messageTitle}>{t('state.empty.title')}</span>
          <span className={css.messageBody}>{t('state.empty.body')}</span>
        </div>
      )
    }
    return (
      <>
        {summary.status.phase === 'building' && (
          <div className={css.progress}>
            <span>{interpolate(t('state.building'), {
              done: summary.status.indexed,
              total: Math.max(summary.status.total, summary.status.indexed),
            })}</span>
            <span className={css.progressTrack}>
              <span
                className={css.progressFill}
                style={{
                  width: `${summary.status.total > 0
                    ? Math.min(100, (summary.status.indexed / summary.status.total) * 100)
                    : 0}%`,
                }}
              />
            </span>
          </div>
        )}
        {error !== undefined && (
          <div className={css.progress} role="status">{error}</div>
        )}
        {view === 'overview'
          ? (
            <>
              <div className={css.statGrid}>
                {cards.map(card => (
                  <StatCard
                    key={card.label}
                    label={card.label}
                    value={card.value}
                    {...(card.hint === undefined ? {} : { hint: card.hint })}
                    {...(card.title === undefined ? {} : { title: card.title })}
                  />
                ))}
              </div>
              <Heatmap
                days={summary.days}
                today={todayOf(summary)}
                span={range === 'all' ? 'year' : range === '30d' ? 30 : 7}
                t={t}
              />
            </>
          )
          : <ModelBars models={summary.models} totalTokens={summary.totalTokens} t={t} />}
      </>
    )
  })()

  return (
    <div className={css.root} ref={rootRef}>
      <h2 className={css.heading}>{t('nav')}</h2>
      <p className={css.intro}>{t('intro')}</p>
      <div className={css.toolbar}>
        <Segmented label={t('nav')} options={VIEWS} value={view} onChange={setView} t={t} />
        <Segmented label={t('nav')} options={RANGES} value={range} onChange={setRange} t={t} />
      </div>
      {body}
      {footer.length > 0 && (
        <div className={css.footer}>
          {footer.map(item => <span key={item} className={css.footerItem}>{item}</span>)}
        </div>
      )}
    </div>
  )
}

/**
 * Today's key in the summary's own timezone.
 *
 * Derived from `generatedAt` rather than the browser clock so the calendar
 * lines up with the day buckets the host produced, even if the two disagree
 * about the zone.
 */
function todayOf(summary: TokenSummary): string {
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone: summary.tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const parts = format.formatToParts(summary.generatedAt)
  const pick = (type: string): string => parts.find(part => part.type === type)?.value ?? ''
  return `${pick('year')}-${pick('month')}-${pick('day')}`
}
