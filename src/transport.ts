/**
 * Host → browser transport.
 *
 * One JSON route on `ctx.webServer`, deliberately not a typert `@Remote`
 * face: the payload is a single snapshot, both halves ship in one package and
 * therefore already share `./types.ts`, and the generator would cost a
 * vendored copy of the protocol source plus a repo layout the plugin skeleton
 * does not use. The browser half reaches this through one function
 * (`client/source.ts`), so swapping the transport later touches nothing else.
 *
 * The trade this makes: a plugin-owned route does NOT pass through the
 * Connection's unified trust check for `/api`. The summary carries working
 * directory paths — effectively a list of the user's projects — so the route
 * answers loopback callers only.
 *
 * @module @zoytown/dsh-token/transport
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TokenIndexStore } from './index-store.ts'
import type { RangeId } from './types.ts'

/** The single route this plugin serves. */
export const SUMMARY_ROUTE = '/plugin-api/dsh-token/summary'

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** Whether a request arrived over the loopback interface. */
export function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  return address !== undefined && LOOPBACK_ADDRESSES.has(address)
}

/** Parse the `range` query parameter, defaulting to all-time. */
export function parseRange(url: string | undefined): RangeId {
  if (url === undefined) return 'all'
  const value = new URL(url, 'http://localhost').searchParams.get('range')
  return value === '7d' || value === '30d' ? value : 'all'
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  response.end(payload)
}

/** Minimal view of the route registry this module needs. */
export interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  }): () => void
}

/**
 * Serve the summary route.
 *
 * @param webServer - `ctx.webServer`.
 * @param store - the index answering the query.
 * @returns the disposer removing the route.
 */
export function registerSummaryRoute(
  webServer: WebServerLike,
  store: Pick<TokenIndexStore, 'summarize' | 'refresh'>,
): () => void {
  return webServer.register({
    kind: 'exact',
    path: SUMMARY_ROUTE,
    handler: (request, response) => {
      if (!isLoopbackRequest(request)) {
        sendJson(response, 403, { error: 'token statistics are served to loopback clients only' })
        return
      }
      try {
        // Never awaited: the panel renders what the index already holds and
        // reports its own build progress, rather than blocking on a scan.
        void store.refresh()
        sendJson(response, 200, store.summarize(parseRange(request.url)))
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
}
