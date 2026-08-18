/**
 * GitHub-style contribution heatmap: 53 weeks of columns, weekdays as rows.
 *
 * Fluid by construction. The tab body can be as narrow as ~508px on a small
 * window, so the grid sizes its columns with `minmax(0, 1fr)` and the cells
 * hold their shape with `aspect-ratio` rather than fixed pixels.
 *
 * Hover detail is a self-drawn tooltip rather than the native `title`
 * attribute: `title` waits a second or two before appearing and is styled by
 * the OS, which reads as a missing feature on a chart whose whole point is
 * per-day detail. One tooltip node is shared by all 371 cells and positioned
 * from the hovered cell's rect — a node per cell would be 371 elements that
 * are almost never shown.
 *
 * @module @zoytown/dsh-token/client/Heatmap
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { TimeBucket } from '../types.ts'
import { exactNumber } from './format.ts'
import { interpolate } from './locales.ts'
import type { Translate } from './runtime.d.ts'
import css from './TokenStatsTab.module.css'

/** Weeks shown; matches the shipped GitHub-style window. */
const WEEKS = 53

const DAY_MS = 86_400_000

/** Colour steps, level 0 being "no activity". */
const LEVELS = 4

/** Gap between the tooltip's caret and the cell it points at. */
const TOOLTIP_OFFSET = 8

/** Keeps the tooltip from overhanging the panel, which the dialog would clip. */
const TOOLTIP_MARGIN = 4

export interface HeatmapProps {
  /** 'YYYY-MM-DD' → that day's activity. */
  days: Record<string, TimeBucket>
  /** Today's local day key, so the grid ends on the right week. */
  today: string
  /**
   * Window to draw. `'year'` is the 53-week calendar; a number is that many
   * days ending today, drawn as a single row.
   *
   * A bounded range must not be drawn on the year grid: 7 days of data on 371
   * cells reads as broken data rather than as a short window.
   */
  span: 'year' | number
  t: Translate
}

interface Cell {
  day: string
  tokens: number
  messages: number
  level: number
}

interface TooltipState {
  /** Cell index, so re-entering the same cell does not re-render. */
  index: number
  left: number
  top: number
}

function dayKey(anchor: number): string {
  return new Date(anchor).toISOString().slice(0, 10)
}

/**
 * Bucket a day's tokens into a colour level.
 *
 * Thresholds are quantiles of the non-empty days rather than fractions of the
 * maximum: one runaway day would otherwise flatten every other day to level 1.
 */
function levelFor(tokens: number, thresholds: readonly number[]): number {
  if (tokens <= 0) return 0
  let level = 1
  for (const threshold of thresholds) {
    if (tokens > threshold) level += 1
  }
  return Math.min(level, LEVELS)
}

function quantiles(values: readonly number[]): number[] {
  if (values.length === 0) return []
  const sorted = [...values].sort((a, b) => a - b)
  const at = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0
  return [at(0.25), at(0.5), at(0.75)]
}

/** One line of tooltip detail, plus the sentence a screen reader hears. */
export function describeCell(cell: Cell, t: Translate): { detail: string; label: string } {
  if (cell.tokens <= 0 && cell.messages <= 0) {
    return {
      detail: t('heatmap.tip.none'),
      label: interpolate(t('heatmap.empty'), { day: cell.day }),
    }
  }
  return {
    detail: interpolate(t('heatmap.tip.detail'), {
      tokens: exactNumber(cell.tokens),
      messages: cell.messages,
    }),
    label: interpolate(t('heatmap.cell'), {
      day: cell.day,
      tokens: exactNumber(cell.tokens),
      messages: cell.messages,
    }),
  }
}

/** The activity calendar. */
export function Heatmap({ days, today, span, t }: HeatmapProps): JSX.Element {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const tipRef = useRef<HTMLDivElement | null>(null)
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)

  const cells = useMemo<Cell[]>(() => {
    // Anchor at noon UTC: a midnight anchor lands on the previous day in
    // negative-offset zones, shifting the whole calendar by one column.
    const [year, month, date] = today.split('-').map(Number)
    const todayAnchor = Date.UTC(year ?? 1970, (month ?? 1) - 1, date ?? 1, 12)
    let firstAnchor: number
    let lastAnchor: number
    if (span === 'year') {
      // Fill the current week to Saturday so today never sits in a clipped column.
      const weekday = new Date(todayAnchor).getUTCDay()
      lastAnchor = todayAnchor + (6 - weekday) * DAY_MS
      firstAnchor = lastAnchor - (WEEKS * 7 - 1) * DAY_MS
    } else {
      lastAnchor = todayAnchor
      firstAnchor = todayAnchor - (span - 1) * DAY_MS
    }

    const thresholds = quantiles(
      Object.values(days).map(bucket => bucket.tokens).filter(tokens => tokens > 0),
    )

    const list: Cell[] = []
    for (let anchor = firstAnchor; anchor <= lastAnchor; anchor += DAY_MS) {
      const day = dayKey(anchor)
      const bucket = days[day]
      const tokens = bucket?.tokens ?? 0
      list.push({
        day,
        tokens,
        messages: bucket?.messages ?? 0,
        level: levelFor(tokens, thresholds),
      })
    }
    return list
  }, [days, today, span])

  /** Anchor the shared tooltip over one cell. */
  const show = useCallback((target: HTMLElement): void => {
    const index = Number(target.dataset['index'])
    const wrap = wrapRef.current
    if (wrap === null || !Number.isInteger(index)) return
    const cellRect = target.getBoundingClientRect()
    const wrapRect = wrap.getBoundingClientRect()
    setTooltip({
      index,
      left: cellRect.left - wrapRect.left + cellRect.width / 2,
      top: cellRect.top - wrapRect.top - TOOLTIP_OFFSET,
    })
  }, [])

  const hide = useCallback((): void => { setTooltip(null) }, [])

  // Measured after paint rather than guessed: the tooltip's width depends on
  // the number's digits, and a cell near either edge would otherwise push it
  // outside the panel, where the dialog's `overflow: hidden` clips it.
  useLayoutEffect(() => {
    const tip = tipRef.current
    const wrap = wrapRef.current
    if (tooltip === null || tip === null || wrap === null) return
    const half = tip.offsetWidth / 2
    const min = half + TOOLTIP_MARGIN
    const max = wrap.offsetWidth - half - TOOLTIP_MARGIN
    const clamped = Math.min(Math.max(tooltip.left, min), Math.max(min, max))
    if (Math.abs(clamped - tooltip.left) > 0.5) {
      setTooltip(current => (current === null ? null : { ...current, left: clamped }))
    }
  }, [tooltip])

  const hovered = tooltip === null ? undefined : cells[tooltip.index]
  const described = hovered === undefined ? undefined : describeCell(hovered, t)

  return (
    <div className={css.heatmap}>
      <div className={css.heatmapWrap} ref={wrapRef}>
        <div
          className={span === 'year' ? css.heatmapGrid : css.heatmapStrip}
          role="grid"
          aria-label={t('stat.activeDays')}
          // Delegated: one pair of listeners rather than 742 of them.
          onMouseOver={event => { show(event.target as HTMLElement) }}
          onMouseLeave={hide}
          onFocus={event => { show(event.target as HTMLElement) }}
          onBlur={hide}
        >
          {cells.map((cell, index) => (
            <div
              key={cell.day}
              className={css.cell}
              data-level={cell.level}
              data-index={index}
              role="gridcell"
              tabIndex={-1}
              aria-label={describeCell(cell, t).label}
            />
          ))}
        </div>
        {described !== undefined && tooltip !== null && (
          <div
            ref={tipRef}
            className={css.tooltip}
            role="tooltip"
            style={{ left: `${tooltip.left}px`, top: `${tooltip.top}px` }}
          >
            <span className={css.tooltipDetail}>{described.detail}</span>
            <span className={css.tooltipDay}>{hovered?.day}</span>
          </div>
        )}
      </div>
      <div className={css.heatmapFooter}>
        <span>{interpolate(t('heatmap.range'), {
          first: cells[0]?.day ?? '',
          last: cells[cells.length - 1]?.day ?? '',
        })}</span>
        <span className={css.legend}>
          {t('heatmap.legend.less')}
          {[0, 1, 2, 3, 4].map(level => (
            <span key={level} className={`${css.legendCell} ${css.cell}`} data-level={level} />
          ))}
          {t('heatmap.legend.more')}
        </span>
      </div>
    </div>
  )
}
