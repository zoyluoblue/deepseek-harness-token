/**
 * Minimal local declarations for the browser-side services this plugin uses.
 *
 * WHY THESE ARE LOCAL: the authoritative types live in
 * `@deepseek-ai/dsh-client-runtime`, which cannot be installed from npm — its
 * `dependencies` name `@deepseek-ai/dsh-compact`, which is not published (404).
 * That blocks type checking only, never the build: the package is in the
 * bundler's `external` list, so no disk resolution happens at build time and
 * the loader answers the specifier at runtime from its frozen module table.
 *
 * Each shape below mirrors upstream and cites its source. Keep them narrow —
 * a smaller surface is a smaller lie.
 *
 * @module @zoytown/dsh-token/client/runtime
 */

/** Registration options for a list slot (ui-slots `src/index.ts:490-496, 527-550`). */
export interface SlotListOptions {
  name: string
  /** Required for list slots; a fresh id is added beside the shipped entries. */
  id: string
  /** Sort key within the list. */
  order?: number
  /**
   * Tab label. Typed optional upstream but effectively required — an omitted
   * label renders a blank button, with no fallback to the id. Pass a thunk so
   * a language switch relabels without re-registering.
   */
  label?: string | (() => string)
  /** Dictionary namespace; declaring it puts a typed `t` on the component. */
  locale?: string
  /** Factory whose return value is spread onto the component's props. */
  inject?: () => Record<string, unknown>
}

/** The two slot methods this plugin calls. */
export interface SlotsService {
  /**
   * Run `body` once the named slot has been DECLARED, and re-run it if the
   * declaration is replaced. A slot that never appears is a silent no-op —
   * which is exactly the desired degradation when the Plugins settings page
   * is not part of the composition.
   */
  inject(name: string, body: () => void): void
  register(options: SlotListOptions, component: unknown): () => void
}

/** Dictionary registration and lookup (client-locale). */
export interface LocaleService {
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
  bind(namespace: string): (key: string) => string
}

/** The slice of the browser context this plugin touches. */
export interface ClientContextLike {
  readonly slots: SlotsService
  readonly locale: LocaleService
  effect(body: () => unknown, label?: string): void
}

/** Localized label lookup handed to a component that declared `locale`. */
export type Translate = (key: string) => string
