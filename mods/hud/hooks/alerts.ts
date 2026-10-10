// The threshold toasts as plain values: which thresholds fired, and the one line to show.
import type { HudFired, HudPrefs, HudUsage } from '../types'
import { span } from './panel.js'

/** A threshold fires again only once its gauge fell this far below it. */
export const REARM_POINTS = 5

const NAMES: Record<string, string> = { five_hour: '5-hour limit', seven_day: '7-day limit', spend_limit: 'Spend limit' }

/**
 * The thresholds each gauge has passed after this reading, and a toast for the
 * first gauge that newly crossed one (its highest), or null when none did.
 */
export function alertsFor(
  alerts: HudPrefs['alerts'],
  was: HudFired,
  usage: HudUsage,
  now: number,
): { fired: HudFired; message: string | null } {
  const fired: HudFired = { ...was }
  let message: string | null = null
  const gauges = [
    { gauge: 'context', value: usage.percent, levels: alerts.context, resetsAt: null as number | null },
    ...usage.limits.map(l => ({ gauge: l.kind, value: l.percent as number | null, levels: alerts.usage, resetsAt: l.resetsAt })),
  ]
  for (const { gauge, value, levels, resetsAt } of gauges) {
    if (value === null || levels.length === 0) continue
    const kept = (was[gauge] ?? []).filter(level => levels.includes(level) && value >= level - REARM_POINTS)
    const crossed = levels.filter(level => value >= level && !kept.includes(level))
    fired[gauge] = [...kept, ...crossed]
    if (crossed.length > 0 && message === null) {
      const name = gauge === 'context' ? 'Context' : (NAMES[gauge] ?? gauge)
      const reset = resetsAt !== null && resetsAt > now ? ` · resets in ${span(resetsAt - now)}` : ''
      message = `${name} at ${Math.round(value)}%${reset}`
    }
  }
  return { fired, message }
}
