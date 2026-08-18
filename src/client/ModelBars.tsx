/**
 * Per-model ranking with the four disjoint buckets stacked.
 *
 * The stack is the point of this view: a headline total that includes cache
 * reads can be dominated by them, and only the split shows it.
 *
 * @module @zoytown/dsh-token/client/ModelBars
 */

import type { Buckets, ModelUsage } from '../types.ts'
import { compactNumber, percent } from './format.ts'
import { interpolate } from './locales.ts'
import type { Translate } from './runtime.d.ts'
import css from './TokenStatsTab.module.css'

/** Bucket render order; also the legend order. */
const BUCKETS: readonly (keyof Buckets)[] = ['input', 'cacheRead', 'cacheWrite', 'output']

const BUCKET_LABEL: Record<keyof Buckets, string> = {
  input: 'bucket.input',
  cacheRead: 'bucket.cacheRead',
  cacheWrite: 'bucket.cacheWrite',
  output: 'bucket.output',
}

export interface ModelBarsProps {
  models: readonly ModelUsage[]
  /** Denominator for the share column. */
  totalTokens: number
  t: Translate
}

/** The Models view. */
export function ModelBars({ models, totalTokens, t }: ModelBarsProps): JSX.Element {
  if (models.length === 0) {
    return (
      <div className={css.message}>
        <span className={css.messageBody}>{t('models.empty')}</span>
      </div>
    )
  }
  return (
    <div className={css.modelList}>
      <div className={css.bucketLegend}>
        {BUCKETS.map(bucket => (
          <span key={bucket} className={css.bucketLegendItem}>
            <span className={`${css.bucketSwatch} ${css.stackPart}`} data-bucket={bucket} />
            {t(BUCKET_LABEL[bucket])}
          </span>
        ))}
      </div>
      {models.map(model => (
        <div key={model.key} className={css.modelRow}>
          <div className={css.modelHead}>
            <span className={css.modelName} title={model.key}>
              {model.model}
              <span className={css.modelProvider}>{` · ${model.provider}`}</span>
            </span>
            <span className={css.modelTotal}>{compactNumber(model.total)}</span>
          </div>
          <div
            className={css.stack}
            role="img"
            aria-label={`${model.key}: ${BUCKETS
              .map(bucket => `${t(BUCKET_LABEL[bucket])} ${compactNumber(model.buckets[bucket])}`)
              .join(', ')}`}
          >
            {BUCKETS.map(bucket => {
              const value = model.buckets[bucket]
              if (value <= 0 || model.total <= 0) return null
              return (
                <span
                  key={bucket}
                  className={css.stackPart}
                  data-bucket={bucket}
                  style={{ width: `${(value / model.total) * 100}%` }}
                />
              )
            })}
          </div>
          <div className={css.bucketLegend}>
            <span>{interpolate(t('models.share'), { percent: percent(model.total, totalTokens) })}</span>
            <span>{interpolate(t('models.samples'), { n: model.samples })}</span>
          </div>
        </div>
      ))}
    </div>
  )
}
