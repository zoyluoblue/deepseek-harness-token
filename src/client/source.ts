/**
 * The transport seam.
 *
 * Everything the panel knows about how data reaches it is this one function.
 * Swapping the host route for a typert `@Remote` face later means rewriting
 * this file and nothing else.
 *
 * @module @zoytown/dsh-token/client/source
 */

import type { RangeId, TokenSummary } from '../types.ts'

/** Must match `SUMMARY_ROUTE` in the host half. */
const SUMMARY_ROUTE = '/plugin-api/dsh-token/summary'

/** Wire schema this build understands. */
const SUPPORTED_VERSION = 1

/** Fetches one summary; rejects with a message fit to show the user. */
export type TokenStatsSource = (range: RangeId, signal: AbortSignal) => Promise<TokenSummary>

function messageOf(body: unknown, status: number): string {
  if (typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string') {
    return (body as { error: string }).error
  }
  return `request failed with status ${status}`
}

/** The shipped source: a same-origin GET against the host route. */
export const fetchSummary: TokenStatsSource = async (range, signal) => {
  const response = await fetch(`${SUMMARY_ROUTE}?range=${encodeURIComponent(range)}`, {
    signal,
    headers: { accept: 'application/json' },
  })
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) throw new Error(messageOf(body, response.status))
  const summary = body as TokenSummary | undefined
  if (summary?.version !== SUPPORTED_VERSION) {
    // A host newer than this bundle is a real possibility during a partial
    // upgrade; saying so beats rendering fields that moved.
    throw new Error('token statistics format mismatch — reload after the update completes')
  }
  return summary
}
