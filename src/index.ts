/**
 * `@zoytown/dsh-token` — host half.
 *
 * Owns a machine-wide index of token usage folded from every dsh home's
 * session logs, and serves it to the browser half over one loopback JSON
 * route. Read-only: this plugin observes logs and never writes to a session,
 * a projection, or another home.
 *
 * Both external services it uses are OPTIONAL, mounted through child fibers
 * rather than `inject`. Vendored cordis has no optional-inject syntax and an
 * unavailable peer leaves a plugin pending forever — which, for this plugin,
 * would silently remove the settings tab with no error anywhere.
 *
 * @module @zoytown/dsh-token
 */

import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: applies the `ctx.webServer` Context merge without a value import.
import type {} from '@deepseek-ai/dsh-host-webserver'
import Schema from 'schemastery'
import { localTimeZone, TokenIndexStore } from './index-store.ts'
import { openIndexPersistence } from './persistence.ts'
import { registerSummaryRoute } from './transport.ts'

export const name = 'dsh-token'

export * from './types.ts'
export { SUMMARY_ROUTE } from './transport.ts'

/** Plugin configuration. */
export interface Config {
  /**
   * Extra dsh home directories to scan. Home discovery is a heuristic over
   * `~/.dsh` and `~/.dsh_desktop/<version>`, not a documented contract, so a
   * home reached through a `$DSH_HOME` that is not currently set is invisible
   * to it — list it here.
   */
  extraSessionRoots: string[]
  /**
   * Count the tokens spent generating compaction summaries. They are real
   * spend that the upstream `tokenUsage` projection cannot see; set false to
   * reconcile 1:1 with it.
   */
  includeCompaction: boolean
  /** How often to re-scan for appended sessions. */
  refreshIntervalMs: number
  /** Cooperative yield interval while scanning, so a cold build stays responsive. */
  indexChunkYieldMs: number
}

export const Config: Schema<Config> = Schema.object({
  extraSessionRoots: Schema.array(String).default([]),
  includeCompaction: Schema.boolean().default(true),
  refreshIntervalMs: Schema.number().min(1000).default(30_000),
  indexChunkYieldMs: Schema.number().min(1).max(1000).default(16),
})

/**
 * Mount the index and its transport.
 * @param ctx - the plugin context.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const store = new TokenIndexStore({
    extraSessionRoots: config.extraSessionRoots,
    includeCompaction: config.includeCompaction,
    chunkYieldMs: config.indexChunkYieldMs,
    currentHome: resolveDshHome(),
  })
  ctx.effect(() => () => { store.dispose() }, 'dshToken.index')

  // Durability is optional: storage is mounted only by the web-app bundle.
  const durableFiber = ctx.inject(['storageDomain'], (childCtx: Context) => {
    let close: (() => Promise<void>) | undefined
    childCtx.effect(() => {
      const opening = openIndexPersistence(childCtx.storageDomain)
        .then(async attached => {
          close = attached.close
          await store.attach(attached.persistence)
          await store.refresh()
        })
        .catch((error: unknown) => {
          // A durable store we cannot open costs a rebuild each boot, never
          // correctness — the memory index below still serves the panel.
          ctx.logger?.warn?.('dsh-token: index persistence unavailable: %s', String(error))
        })
      return async () => {
        await opening
        store.detach()
        await close?.()
      }
    }, 'dshToken.persistence')
  })
  ctx.effect(() => () => { durableFiber.dispose() }, 'dshToken.optionalStorage')

  // The transport is optional too: a headless composition has no web server,
  // and the index is still worth keeping warm for whoever attaches later.
  const serverFiber = ctx.inject(['webServer'], (childCtx: Context) => {
    childCtx.effect(() => registerSummaryRoute(childCtx.webServer, store), 'dshToken.route')
  })
  ctx.effect(() => () => { serverFiber.dispose() }, 'dshToken.optionalWebServer')

  ctx.effect(() => {
    void store.refresh()
    const timer = setInterval(() => { void store.refresh() }, config.refreshIntervalMs)
    // Node keeps the process alive for pending timers; a statistics refresh
    // must never be the reason a headless run does not exit.
    timer.unref?.()
    return () => { clearInterval(timer) }
  }, 'dshToken.refreshLoop')

  ctx.logger?.debug?.('dsh-token: indexing in %s', localTimeZone())
}
