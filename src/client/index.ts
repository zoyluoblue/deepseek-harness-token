/**
 * `@zoytown/dsh-token` — browser half.
 *
 * Contributes one top-level nav entry to the Settings dialog. The sidebar is
 * not a hardcoded list: it is a projection of the `settings.section` slot
 * ledger sorted by `order`, so a fresh id is added beside the shipped rows.
 *
 * Deliberately NOT also a tab under Settings → Plugins. The same page in two
 * places is two things to keep consistent and two places for the user to find
 * a different answer; the sidebar is the one that was asked for.
 *
 * The nav glyph is a hardcoded id switch in the shell with no registration
 * seam, so this row renders with the generic gear — the same fallback the
 * sibling billing plugin's row gets.
 *
 * `ctx.slots.inject` waits for the declaration and is a silent no-op when the
 * settings shell is not part of the composition — the intended degradation.
 *
 * @module @zoytown/dsh-token/client
 */

import { dictionaries, NS } from './locales.ts'
import type { ClientContextLike } from './runtime.d.ts'
import { TokenStatsTab } from './TokenStatsTab.tsx'

/** The slot this plugin registers into. */
const SLOT = 'settings.section'

/** Sorts after the shipped rows (general 0, models 10, plugins 15, agent-presets 20) and after billing (50). */
const ORDER = 60

/** Browser-side services this plugin needs. */
export const inject = ['slots', 'locale']

export { NS }

/**
 * Register the Token settings page.
 * @param ctx - the browser context.
 */
export function apply(ctx: ClientContextLike): void {
  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'dshToken.dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject(SLOT, () => ctx.slots.register({
    name: SLOT,
    id: 'dsh-token',
    order: ORDER,
    // A thunk, not a string: the label is re-read per projection, so a
    // language switch relabels the row without re-registering it.
    label: () => t('nav'),
    locale: NS,
  }, TokenStatsTab))
}
