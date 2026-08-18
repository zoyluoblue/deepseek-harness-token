/**
 * Durable backing for the index, over `ctx.storageDomain`.
 *
 * Two upstream behaviours shape everything here, and both are fatal if
 * ignored:
 *
 *  - A stored medium whose stamped version differs from the spec's throws
 *    `version-mismatch` out of `open()`, and nothing catches it — the owning
 *    service would never become injectable. So {@link DOMAIN_VERSION} is
 *    frozen at 1 forever and the payload carries its own {@link ROW_SCHEMA}.
 *  - A single stored record failing its zod schema fails the WHOLE open with
 *    `invalid-record`. So every record is an opaque `{v, data}` envelope that
 *    cannot fail, and the real shape is validated by hand, per row, with a bad
 *    row dropped rather than migrated. (This is the same discipline the
 *    shipped session-projection cache uses.)
 *
 * @module @zoytown/dsh-token/persistence
 */

import { z, type ZodType } from 'zod'
// Type-only: the Context merge that puts `storageDomain` on the context, and
// the spec/handle interfaces. Deliberately no VALUE import from a
// @deepseek-ai package that is mounted by only one bundle — a static value
// import would make this module unloadable wherever that bundle is absent.
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {
  Domain,
  DomainSpec,
  DomainTableSpec,
} from '@deepseek-ai/dsh-storage-domain'
import type { IndexEntry, IndexMeta, IndexPersistence } from './index-store.ts'
import { FOLD_VERSION } from './fold.ts'

/** Frozen for the life of the plugin. See the module note. */
const DOMAIN_VERSION = 1

/** Payload shape version. Bump this instead of {@link DOMAIN_VERSION}. */
export const ROW_SCHEMA = 1

/**
 * Local mirror of upstream's `domainTable`, which is a pure type carrier
 * (`schema => ({ valueSchema: schema })`). Inlined so this module needs no
 * runtime import from the storage-domain package.
 */
function table<K extends string, V>(schema: ZodType<V>): DomainTableSpec<K, V> {
  return { valueSchema: schema }
}

/** The opaque envelope. `data` is never validated at the durable boundary. */
const envelopeSchema = z.object({
  v: z.number().int().nonnegative(),
  data: z.unknown(),
})

interface Envelope {
  v: number
  data: unknown
}

/** Shard record key, 'c00'..'c1f'. */
type ShardKey = string

/**
 * The domain declaration.
 *
 * `name` must match upstream's `UNIT_NAME_RE` (`/^[a-z][a-z0-9_]*$/`) or the
 * facility throws at open; the test suite asserts it rather than trusting it.
 */
export const TOKEN_INDEX_DOMAIN = {
  name: 'dsh_token_index',
  version: DOMAIN_VERSION,
  global: {
    schema: envelopeSchema,
    initial: { v: ROW_SCHEMA, data: null } as Envelope,
  },
  tables: {
    shards: table<ShardKey, Envelope>(envelopeSchema),
  },
} satisfies DomainSpec

/** Structural guard: a row that fails is dropped, and its session refolded. */
function isIndexEntry(value: unknown): value is IndexEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Partial<IndexEntry>
  return typeof entry.path === 'string'
    && typeof entry.size === 'number'
    && typeof entry.mtimeMs === 'number'
    && typeof entry.ino === 'number'
    && typeof entry.dev === 'number'
    && typeof entry.cursor === 'number'
    && typeof entry.header === 'object' && entry.header !== null
    && typeof entry.fold === 'object' && entry.fold !== null
    && typeof entry.carry === 'object' && entry.carry !== null
}

function isIndexMeta(value: unknown): value is IndexMeta {
  if (typeof value !== 'object' || value === null) return false
  const meta = value as Partial<IndexMeta>
  return typeof meta.tz === 'string'
    && typeof meta.foldVersion === 'number'
    && typeof meta.builtAt === 'number'
}

/** Minimal view of the facility this module needs; keeps the surface honest. */
export interface DomainFacilityLike {
  open<S extends DomainSpec>(spec: S): Promise<Domain<S>>
}

/** An attached durable store plus its teardown. */
export interface AttachedPersistence {
  persistence: IndexPersistence
  close: () => Promise<void>
}

/**
 * Open the index domain and wrap it as an {@link IndexPersistence}.
 *
 * @param facility - `ctx.storageDomain`.
 * @returns the port and a close function the caller must run on disposal —
 * the facility hands ownership of the handle to the opener.
 */
export async function openIndexPersistence(
  facility: DomainFacilityLike,
): Promise<AttachedPersistence> {
  const domain = await facility.open(TOKEN_INDEX_DOMAIN)
  const shards = domain.table('shards')

  const persistence: IndexPersistence = {
    async load() {
      const storedMeta = domain.global.get()
      if (storedMeta.v !== ROW_SCHEMA || !isIndexMeta(storedMeta.data)) return undefined
      const meta = storedMeta.data
      if (meta.foldVersion !== FOLD_VERSION) return undefined
      const entries = new Map<string, IndexEntry>()
      for (const [, envelope] of shards.entries()) {
        if (envelope.v !== ROW_SCHEMA) continue
        const rows = envelope.data
        if (typeof rows !== 'object' || rows === null) continue
        for (const [key, row] of Object.entries(rows as Record<string, unknown>)) {
          if (isIndexEntry(row)) entries.set(key, row)
        }
      }
      return { meta, entries }
    },

    async saveShards(dirty) {
      for (const [shard, rows] of dirty) {
        if (Object.keys(rows).length === 0) await shards.delete(shard)
        else await shards.put(shard, { v: ROW_SCHEMA, data: rows })
      }
    },

    async saveMeta(meta) {
      await domain.global.set({ v: ROW_SCHEMA, data: meta })
    },

    async clear() {
      for (const key of [...shards.keys()]) await shards.delete(key)
      await domain.global.set({ v: ROW_SCHEMA, data: null })
    },
  }

  return { persistence, close: () => domain.close() }
}
