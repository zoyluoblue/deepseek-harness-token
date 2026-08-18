/**
 * Presentation-only formatting. Pure functions, no locale service — the
 * strings that need translating go through the dictionary instead.
 *
 * @module @zoytown/dsh-token/client/format
 */

const UNITS = ['', 'K', 'M', 'B', 'T'] as const

/**
 * Compact a token count the way a headline number wants to read: 40.1M, 954K,
 * 512. Exact below 1,000 so small numbers never look rounded.
 */
export function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const sign = value < 0 ? '-' : ''
  let magnitude = Math.abs(value)
  let unit = 0
  while (magnitude >= 1000 && unit < UNITS.length - 1) {
    magnitude /= 1000
    unit += 1
  }
  if (unit === 0) return `${sign}${Math.round(magnitude)}`
  const digits = magnitude < 10 ? 2 : magnitude < 100 ? 1 : 0
  return `${sign}${magnitude.toFixed(digits)}${UNITS[unit]}`
}

/** Group with thin separators; used in tooltips where exactness matters. */
export function exactNumber(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

/**
 * Render a clock hour through the dictionary's own pattern.
 *
 * Locale-dependent by nature: `2 PM` is right in English and wrong in Chinese,
 * where a 24-hour reading is the norm. The pattern lives in the dictionary so
 * a new language brings its own convention rather than inheriting English's.
 *
 * @param hour - local hour 0-23, or null when there is no data.
 * @param pattern - dictionary value with `{h12}`, `{h24}` and `{period}` slots.
 * @param am - localized morning marker.
 * @param pm - localized afternoon marker.
 */
export function formatHour(hour: number | null, pattern: string, am: string, pm: string): string {
  if (hour === null) return '—'
  return pattern
    .replace('{h12}', String(hour % 12 === 0 ? 12 : hour % 12))
    .replace('{h24}', String(hour))
    .replace('{period}', hour < 12 ? am : pm)
}

/** `provider/model` → the model half, which is what the user recognises. */
export function shortModel(key: string | null): string {
  if (key === null) return '—'
  const slash = key.indexOf('/')
  return slash < 0 ? key : key.slice(slash + 1)
}

/** Percentage with one decimal below 10%, none above. */
export function percent(part: number, whole: number): string {
  if (whole <= 0) return '0'
  const value = (part / whole) * 100
  return value < 10 ? value.toFixed(1) : String(Math.round(value))
}
