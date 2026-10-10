// The HUD as plain data: one line per part, a label on the left and its value
// flush right, a gauge between them where there is one. Says what each line
// holds, its tones, and which lines leave first when there is no room. No `$`.
import type { HudActivity, HudCache, HudCompact, HudLimit, HudModel, HudRepo, HudUsage } from '../types'

/** What a span means; PALETTE turns it into a color. */
export type Tone = 'label' | 'value' | 'dim' | 'model' | 'project' | 'clean' | 'dirty' | 'ok' | 'warn' | 'crit' | 'cache' | 'cost' | 'busy'

export type Span = { text: string; tone: Tone; bold?: boolean }

/** How alarming a gauge reads. */
export type Level = 'ok' | 'warn' | 'crit'

export type Line = {
  key: string
  label: string
  /** A gauge between the label and the value, 0 to 100. */
  gauge?: { percent: number; tone: Tone }
  /** Drawn flush right. */
  value: Span[]
  /** When the line leaves a short panel, lowest first; KEEP stays. */
  rank: number
  level?: Level
  /** The line carries a control: `compact` runs /compact. */
  action?: 'compact'
}

export type View = {
  project: string | null
  repo: HudRepo
  usage: HudUsage
  model: HudModel
  compact: HudCompact
  cache: HudCache
  activity: HudActivity
  now: number
}

/** Lines at this rank never leave: model, project, context, the first plan window. */
export const KEEP = 100

const RANK = { running: 1, cost: 2, laterLimit: 3, branch: 4, cache: 5, compact: 6 } as const

/** A line that warns leaves after every calm one. */
const WARN_BONUS = 20

/** The CRT's phosphors: a dark glass, green labels, and a color per meaning. One place to recolor. */
export const PALETTE = {
  bg: '#070b08',
  scan: '#0b120d',
  bezel: '#18241c',
  edge: '#1f3a29',
  track: '#16301f',
  label: '#4ea26a',
  dim: '#2f6a45',
  value: '#d6ffe1',
  model: '#ffa94d',
  project: '#6cc7ff',
  clean: '#7dff9a',
  dirty: '#ffd166',
  ok: '#5cff8a',
  warn: '#ffc145',
  crit: '#ff5c5c',
  cache: '#4fe3d0',
  cost: '#c79bff',
  busy: '#9fb3ff',
} as const

export const TTL_MS = { '5m': 5 * 60_000, '1h': 60 * 60_000 } as const

/** Below this, an expired cache costs little to rebuild and stays calm. */
export const COLD_WARN_TOKENS = 20_000

const FAMILIES: Record<string, string> = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable' }
const LIMIT_LABELS: Record<string, string> = { five_hour: '5-HOUR', seven_day: '7-DAY', spend_limit: 'SPEND' }
const LIMIT_ORDER = ['five_hour', 'seven_day', 'spend_limit']

/** `claude-opus-5-5[1m]` → `Opus 5.5 1M`; anything else as given, less `claude-`. */
export function modelName(id: string): string {
  const isLong = /\[1m\]$/i.test(id)
  const bare = id.replace(/\[1m\]$/i, '')
  const match = /claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(bare)
  const family = match?.[1] ? FAMILIES[match[1].toLowerCase()] : FAMILIES[bare.toLowerCase()]
  const name = match && family ? `${family} ${match[2]}${match[3] ? `.${match[3]}` : ''}` : family ?? bare.replace(/^claude-/, '')
  return isLong ? `${name} 1M` : name
}

/** 850, 8.4k, 76k, 1.2M. */
export function tokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  if (Math.round(n / 1000) < 1000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/** A countdown in whole minutes, rounded up: <1m, 14m, 2h05m, 3d4h. */
export function span(ms: number): string {
  if (ms < 60_000) return '<1m'
  const minutes = Math.ceil(ms / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const rest = minutes % 60
  if (days > 0) return `${days}d${hours}h`
  if (hours > 0) return `${hours}h${String(rest).padStart(2, '0')}m`
  return `${rest}m`
}

export function levelAt(value: number, warn: number, crit: number): Level {
  return value >= crit ? 'crit' : value >= warn ? 'warn' : 'ok'
}

/** `mcp__server__tool` → `tool`; built-in names as they are. */
export function toolName(tool: string): string {
  return tool.startsWith('mcp__') ? tool.split('__').slice(2).join('__') || tool : tool
}

const s = (text: string, tone: Tone, bold?: boolean): Span => (bold ? { text, tone, bold } : { text, tone })

function modelLine(model: HudModel): Line | null {
  if (!model.id) return null
  const value = [s(modelName(model.id), 'model', true)]
  if (model.effort) value.push(s(' · ', 'dim'), s(model.effort, 'model'))
  return { key: 'model', label: 'MODEL', value, rank: KEEP }
}

function projectLines(project: string | null, repo: HudRepo): Line[] {
  if (!project) return []
  const lines: Line[] = [{ key: 'project', label: 'PROJECT', value: [s(project, 'project', true)], rank: KEEP }]
  if (repo?.branch) {
    const value = [s(repo.branch, repo.dirty > 0 ? 'dirty' : 'clean')]
    if (repo.dirty > 0) value.push(s(` ±${repo.dirty}`, 'dirty'))
    lines.push({ key: 'branch', label: 'BRANCH', value, rank: RANK.branch })
  }
  return lines
}

function contextLines(usage: HudUsage, compact: HudCompact): Line[] {
  if (usage.window <= 0) return []
  if (usage.tokens === null) {
    return [{ key: 'context', label: 'CONTEXT', gauge: { percent: 0, tone: 'ok' }, value: [s(`–/${tokens(usage.window)}`, 'dim')], rank: KEEP }]
  }
  const percent = usage.percent ?? Math.round((usage.tokens / usage.window) * 100)
  const level = levelAt(percent, 70, 85)
  const lines: Line[] = [
    {
      key: 'context',
      label: 'CONTEXT',
      gauge: { percent, tone: level },
      value: [s(`${percent}%`, level, level !== 'ok'), s(` ${tokens(usage.tokens)}/${tokens(usage.window)}`, 'dim')],
      rank: KEEP,
      level,
    },
  ]
  if (compact?.at) {
    const left = tokens(Math.max(0, compact.at - usage.tokens))
    const tone: Tone = level === 'ok' ? 'value' : level
    lines.push({ key: 'compact', label: 'COMPACT', value: [s('in ', 'dim'), s(left, tone)], rank: RANK.compact, action: 'compact' })
  }
  return lines
}

function limitLine(limit: HudLimit, now: number, isFirst: boolean): Line {
  const level = levelAt(limit.percent, 80, 95)
  const value = [s(`${Math.round(limit.percent)}%`, level, level !== 'ok')]
  if (limit.resetsAt !== null && limit.resetsAt > now) value.push(s(` ↻${span(limit.resetsAt - now)}`, 'dim'))
  return {
    key: limit.kind,
    label: LIMIT_LABELS[limit.kind] ?? limit.kind.toUpperCase(),
    gauge: { percent: limit.percent, tone: level },
    value,
    rank: isFirst ? KEEP : RANK.laterLimit,
    level,
  }
}

function planLines(usage: HudUsage, now: number): Line[] {
  const order = (kind: string) => (LIMIT_ORDER.includes(kind) ? LIMIT_ORDER.indexOf(kind) : LIMIT_ORDER.length)
  return [...usage.limits].sort((a, b) => order(a.kind) - order(b.kind)).map((limit, i) => limitLine(limit, now, i === 0))
}

function cacheLine(cache: HudCache, now: number): Line | null {
  if (cache.lastRequestAt === null) return null
  const left = cache.lastRequestAt + TTL_MS[cache.ttl] - now
  if (left > 0) {
    return { key: 'cache', label: 'CACHE', value: [s(`${cache.isTtlKnown ? '' : '~'}${span(left)}`, 'cache')], rank: RANK.cache }
  }
  const isCostly = cache.tokens !== null && cache.tokens >= COLD_WARN_TOKENS
  const tone: Tone = isCostly ? 'warn' : 'dim'
  const value = [s('expired', tone, isCostly)]
  if (cache.tokens !== null) value.push(s(' · re-caches ', 'dim'), s(tokens(cache.tokens), tone))
  return { key: 'cache', label: 'CACHE', value, rank: RANK.cache, ...(isCostly ? { level: 'warn' as const } : {}) }
}

function costLine(usage: HudUsage): Line | null {
  return usage.usd === null ? null : { key: 'cost', label: 'COST', value: [s(`$${usage.usd.toFixed(2)}`, 'cost')], rank: RANK.cost }
}

function runningLine(activity: HudActivity): Line | null {
  const tools = [...new Set(Object.values(activity.tools))]
  const value: Span[] = []
  if (tools[0]) value.push(s(tools[0] + (tools.length > 1 ? ` +${tools.length - 1}` : ''), 'busy'))
  if (activity.agents > 0) {
    if (value.length) value.push(s(' · ', 'dim'))
    value.push(s(`${activity.agents} agent${activity.agents === 1 ? '' : 's'}`, 'busy'))
  }
  return value.length ? { key: 'running', label: 'RUNNING', value, rank: RANK.running } : null
}

/** Who and where first, then the meters, then what runs. */
export function buildPanel(v: View): Line[] {
  return [
    modelLine(v.model),
    ...projectLines(v.project, v.repo),
    ...contextLines(v.usage, v.compact),
    ...planLines(v.usage, v.now),
    cacheLine(v.cache, v.now),
    costLine(v.usage),
    runningLine(v.activity),
  ].filter((line): line is Line => line !== null)
}

const effectiveRank = (line: Line) => (line.level === 'warn' || line.level === 'crit' ? line.rank + WARN_BONUS : line.rank)

/** Drops lines, lowest rank first, until at most `max` remain; KEEP lines stay. */
export function fitPanel(lines: Line[], max: number): Line[] {
  let out = lines
  while (out.length > max) {
    const droppable = out.filter(l => l.rank < KEEP)
    if (droppable.length === 0) break
    const drop = droppable.reduce((low, l) => (effectiveRank(l) < effectiveRank(low) ? l : low))
    out = out.filter(l => l !== drop)
  }
  return out
}

export const textOf = (spans: readonly Span[]) => spans.map(x => x.text).join('')

/** The panel as plain lines, label and value: the drawing's text for a reader that cannot see it. */
export function panelText(lines: readonly Line[]): string {
  return lines.map(l => `${l.label} ${l.gauge ? `[${Math.round(l.gauge.percent)}%] ` : ''}${textOf(l.value)}`).join('\n')
}
