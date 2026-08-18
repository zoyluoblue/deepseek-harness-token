/**
 * Dictionaries for the Token tab.
 *
 * Runtime copy is TypeScript dictionaries registered through `ctx.locale`; the
 * `*.i18n.yaml` files in the upstream tree are documentation pairing records
 * and are never loaded by the client.
 *
 * @module @zoytown/dsh-token/client/locales
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.dshToken'

const en = {
  'nav': 'Token',
  'intro': 'Token usage across every dsh home on this machine.',
  'view.overview': 'Overview',
  'view.models': 'Models',
  'range.all': 'All',
  'range.30d': '30d',
  'range.7d': '7d',
  'stat.sessions': 'Sessions',
  'stat.sessions.subagents': '+{n} subagent',
  'stat.messages': 'Messages',
  'stat.tokens': 'Total tokens',
  'stat.activeDays': 'Active days',
  'stat.currentStreak': 'Current streak',
  'stat.longestStreak': 'Longest streak',
  'stat.peakHour': 'Peak hour',
  'stat.favoriteModel': 'Favorite model',
  'stat.peakHour.pattern': '{h12} {period}',
  'time.am': 'AM',
  'time.pm': 'PM',
  'unit.days': 'd',
  'bucket.input': 'Input',
  'bucket.cacheRead': 'Cache read',
  'bucket.cacheWrite': 'Cache write',
  'bucket.output': 'Output',
  'heatmap.range': '{first} – {last}',
  'heatmap.legend.less': 'Less',
  'heatmap.legend.more': 'More',
  'heatmap.cell': '{day}: {tokens} tokens, {messages} messages',
  'heatmap.empty': '{day}: no activity',
  'heatmap.tip.detail': '{tokens} tokens · {messages} messages',
  'heatmap.tip.none': 'No activity',
  'models.empty': 'No model usage recorded yet.',
  'models.share': '{percent}% of all tokens',
  'models.samples': '{n} calls',
  'state.loading': 'Reading session logs…',
  'state.building': 'Indexing {done} of {total} sessions…',
  'state.error.title': 'Could not load token statistics',
  'state.retry': 'Retry',
  'state.empty.title': 'No sessions yet',
  'state.empty.body': 'Token statistics appear once you have talked to an agent.',
  'footer.homes': '{n} dsh home',
  'footer.homes.plural': '{n} dsh homes',
  'footer.updated': 'updated {when}',
  'footer.memoryOnly': 'in-memory index (no durable storage in this profile)',
  'footer.coverage': '{percent}% of steps had provider metering',
  'footer.retried': '{n} retried steps not counted',
  'footer.truncated': '{n} sessions still being written',
  'footer.skipped': '{n} logs skipped',
  'when.never': 'never',
  'when.now': 'just now',
  'when.minutes': '{n}m ago',
  'when.hours': '{n}h ago',
  'when.days': '{n}d ago',
  'note.cacheIncluded': 'Totals include cache reads.',
}

const zh: typeof en = {
  'nav': 'Token',
  'intro': '本机所有 dsh home 的 token 用量。',
  'view.overview': '总览',
  'view.models': '模型',
  'range.all': '全部',
  'range.30d': '30天',
  'range.7d': '7天',
  'stat.sessions': '会话数',
  'stat.sessions.subagents': '另有 {n} 个子会话',
  'stat.messages': '消息数',
  'stat.tokens': '总 tokens',
  'stat.activeDays': '活跃天数',
  'stat.currentStreak': '当前连续',
  'stat.longestStreak': '最长连续',
  'stat.peakHour': '高峰时段',
  'stat.favoriteModel': '常用模型',
  'stat.peakHour.pattern': '{h24}:00',
  'time.am': '上午',
  'time.pm': '下午',
  'unit.days': '天',
  'bucket.input': '输入',
  'bucket.cacheRead': '缓存读',
  'bucket.cacheWrite': '缓存写',
  'bucket.output': '输出',
  'heatmap.range': '{first} 至 {last}',
  'heatmap.legend.less': '少',
  'heatmap.legend.more': '多',
  'heatmap.cell': '{day}：{tokens} tokens，{messages} 条消息',
  'heatmap.empty': '{day}：无活动',
  'heatmap.tip.detail': '{tokens} tokens · {messages} 条消息',
  'heatmap.tip.none': '无活动',
  'models.empty': '还没有模型用量记录。',
  'models.share': '占总量 {percent}%',
  'models.samples': '{n} 次调用',
  'state.loading': '正在读取会话日志…',
  'state.building': '正在索引 {done} / {total} 个会话…',
  'state.error.title': '无法加载 token 统计',
  'state.retry': '重试',
  'state.empty.title': '还没有会话',
  'state.empty.body': '与智能体对话之后，这里会出现 token 统计。',
  'footer.homes': '{n} 个 dsh home',
  'footer.homes.plural': '{n} 个 dsh home',
  'footer.updated': '更新于{when}',
  'footer.memoryOnly': '内存索引（当前 profile 没有持久化存储）',
  'footer.coverage': '{percent}% 的步骤有 provider 计量',
  'footer.retried': '{n} 个重试步骤未计入',
  'footer.truncated': '{n} 个会话仍在写入',
  'footer.skipped': '跳过 {n} 个日志',
  'when.never': '从未',
  'when.now': '刚刚',
  'when.minutes': '{n} 分钟前',
  'when.hours': '{n} 小时前',
  'when.days': '{n} 天前',
  'note.cacheIncluded': '总量含缓存读。',
}

/** Dictionaries in the shape `ctx.locale.register` expects. */
export const dictionaries = { en, zh }

/** Substitute `{name}` placeholders. */
export function interpolate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = values[key]
    return value === undefined ? match : String(value)
  })
}
