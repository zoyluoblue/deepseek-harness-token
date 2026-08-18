/**
 * Enumeration of every dsh home on this machine (decision D1).
 *
 * `ctx.sessionPersistence` is bound to a single root
 * (`packages/bundle/base/cordis.patch.yml:98-101`), so machine-wide statistics
 * cannot go through it. Homes are discovered instead, and de-duplicated by the
 * realpath of their `sessions` directory so an aliased or symlinked home is
 * never counted twice.
 *
 * The `~/.dsh_desktop/<version>` layout is a Desktop-shell invention
 * (deepseek-harness-desktop `src/main/home.ts`), not an upstream contract —
 * hence `extraSessionRoots` in the plugin config for anything this heuristic
 * cannot see (e.g. a custom `$DSH_HOME` used previously but not set now).
 *
 * @module @zoytown/dsh-token/homes
 */

import { readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Directory name the Desktop shell versions its homes under. */
const DESKTOP_DATA_DIR = '.dsh_desktop'

/** One discovered dsh home with a readable sessions directory. */
export interface DshHome {
  /** The home directory as discovered; display only. */
  home: string
  /** realpath'd `<home>/sessions` — THIS is the dedupe identity. */
  sessionsRoot: string
  /** True for the home this process is running against. */
  current: boolean
}

/** A home that was found but could not be used. */
export interface HomeProblem {
  home: string
  /** The errno code or message; surfaced to the UI, never fatal. */
  error: string
}

/** Discovery result: usable homes plus the ones that failed. */
export interface HomeDiscovery {
  homes: DshHome[]
  problems: HomeProblem[]
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code ?? String(error)
}

/** Where to look. Every source is overridable so discovery can be tested hermetically. */
export interface DiscoveryOptions {
  /** The home this process resolved at boot. */
  currentHome: string
  /** Configured additional home directories. */
  extraRoots?: readonly string[]
  /** Environment to read `DSH_HOME` from. */
  env?: NodeJS.ProcessEnv
  /** OS home directory; `~/.dsh` and `~/.dsh_desktop` hang off it. */
  osHome?: string
}

/**
 * Discover every dsh home that has a sessions directory.
 *
 * Candidates are `~/.dsh`, the current home, `$DSH_HOME`, every immediate
 * subdirectory of `~/.dsh_desktop`, and any configured extra roots. A
 * candidate without a `sessions` directory is skipped silently — that is an
 * ordinary state for a freshly created home, not a problem.
 *
 * @param options - where to look.
 * @returns usable homes (deduped by realpath) and unusable ones with a reason.
 */
export async function discoverDshHomes(options: DiscoveryOptions): Promise<HomeDiscovery> {
  const { currentHome, extraRoots = [], env = process.env, osHome = homedir() } = options
  const candidates = new Set<string>([join(osHome, '.dsh'), currentHome])
  const envHome = env['DSH_HOME']?.trim()
  if (envHome !== undefined && envHome.length > 0) candidates.add(envHome)
  for (const root of extraRoots) {
    const trimmed = root.trim()
    if (trimmed.length > 0) candidates.add(trimmed)
  }

  const problems: HomeProblem[] = []
  const desktopRoot = join(osHome, DESKTOP_DATA_DIR)
  try {
    for (const entry of await readdir(desktopRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.add(join(desktopRoot, entry.name))
    }
  } catch (error) {
    // ENOENT: no Desktop app on this machine. Anything else is worth showing.
    if (errorCode(error) !== 'ENOENT') problems.push({ home: desktopRoot, error: errorCode(error) })
  }

  let currentReal: string | undefined
  try {
    currentReal = await realpath(join(currentHome, 'sessions'))
  } catch {
    // The current home may legitimately have no sessions yet; `current` then
    // simply never matches, which only affects a display flag.
  }

  const byRoot = new Map<string, DshHome>()
  for (const home of candidates) {
    let sessionsRoot: string
    try {
      sessionsRoot = await realpath(join(home, 'sessions'))
    } catch (error) {
      const code = errorCode(error)
      if (code !== 'ENOENT') problems.push({ home, error: code })
      continue
    }
    if (byRoot.has(sessionsRoot)) continue
    byRoot.set(sessionsRoot, { home, sessionsRoot, current: sessionsRoot === currentReal })
  }
  return { homes: [...byRoot.values()], problems }
}
