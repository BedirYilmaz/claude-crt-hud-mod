// Text the HUD reads and turns into values: git's porcelain status, the
// transcript's last cache write, and `/hud`'s arguments. No `$` here.
import type { HudHitPointer, HudHitProps, HudPrefs, HudRepo } from '../types'

/** `git status --porcelain=v2 --branch` → the branch and how many paths changed. */
export function parseGitStatus(stdout: string): NonNullable<HudRepo> {
  let head: string | null = null
  let oid: string | null = null
  let dirty = 0
  for (const line of stdout.split('\n')) {
    if (!line) continue
    if (line.startsWith('# branch.head ')) head = line.slice('# branch.head '.length).trim()
    else if (line.startsWith('# branch.oid ')) oid = line.slice('# branch.oid '.length).trim()
    else if (!line.startsWith('#')) dirty += 1
  }
  if (head !== '(detached)') return { branch: head, dirty }
  return { branch: oid && oid !== '(initial)' ? `@${oid.slice(0, 7)}` : null, dirty }
}

/** How far back from the end the transcript is searched for a cache write. */
const SCAN_LINES = 5000

type CacheCreation = { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number }
type Entry = { type?: string; isSidechain?: boolean; message?: { usage?: { cache_creation?: CacheCreation } } }

/**
 * The TTL tier the main thread's latest cache write used, read from the
 * transcript's end; null when none of the lines searched wrote to the cache.
 * The mod API reports cache tokens but not their tier.
 */
export function lastCacheTtl(text: string): '5m' | '1h' | null {
  let end = text.length
  for (let i = 0; i < SCAN_LINES && end > 0; i++) {
    const start = text.lastIndexOf('\n', end - 1) + 1
    const line = text.slice(start, end)
    end = start - 1
    if (!line.includes('"cache_creation"')) continue
    let entry: Entry
    try {
      entry = JSON.parse(line) as Entry
    } catch {
      continue
    }
    if (entry.type !== 'assistant' || entry.isSidechain === true) continue
    const written = entry.message?.usage?.cache_creation
    if ((written?.ephemeral_1h_input_tokens ?? 0) > 0) return '1h'
    if ((written?.ephemeral_5m_input_tokens ?? 0) > 0) return '5m'
  }
  return null
}

export const HUD_USAGE = [
  '/hud              turn the HUD on or off',
  '/hud on | off',
  '/hud above        a band above the prompt',
  '/hud below        under the prompt, beside the hint line',
  '/hud alerts       show the toast thresholds',
  '/hud alerts context 80,90 usage 90',
  '/hud alerts off',
  '/hud debug        what the click layer over the desktop screen has seen',
].join('\n')

/** `80,90` → [80, 90]; `off` → []; null when any value is not a whole percent from 1 to 100. */
function levels(word: string | undefined): number[] | null {
  if (word === undefined) return null
  if (word === 'off') return []
  const values = word.split(',').filter(Boolean).map(Number)
  const isValid = values.length > 0 && values.every(v => Number.isInteger(v) && v >= 1 && v <= 100)
  return isValid ? [...new Set(values)].sort((a, b) => a - b) : null
}

const list = (values: number[]) => (values.length ? values.map(v => `${v}%`).join(', ') : 'off')

export function describeAlerts(alerts: HudPrefs['alerts']): string {
  if (!alerts.context.length && !alerts.usage.length) return 'Alerts off'
  return `Alerts: context ${list(alerts.context)} · usage ${list(alerts.usage)}`
}

function describePrefs(prefs: HudPrefs): string {
  return prefs.isVisible ? `HUD on, ${prefs.position === 'above' ? 'above' : 'below'} the prompt` : 'HUD off'
}

/** What `/hud <args>` does: the prefs it leaves (unchanged when it only reports) and the line it answers. */
export function runHudCommand(args: string, prefs: HudPrefs): { prefs: HudPrefs; text: string } {
  const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const [verb, ...rest] = words
  const set = (next: HudPrefs) => ({ prefs: next, text: describePrefs(next) })
  switch (verb) {
    case undefined:
      return set({ ...prefs, isVisible: !prefs.isVisible })
    case 'on':
    case 'off':
      return set({ ...prefs, isVisible: verb === 'on' })
    case 'above':
    case 'below':
      return set({ ...prefs, isVisible: true, position: verb })
    case 'alerts': {
      if (rest.length === 0) return { prefs, text: describeAlerts(prefs.alerts) }
      if (rest.length === 1 && rest[0] === 'off') {
        const next = { ...prefs, alerts: { context: [], usage: [] } }
        return { prefs: next, text: describeAlerts(next.alerts) }
      }
      const alerts = { ...prefs.alerts }
      for (let i = 0; i < rest.length; i += 2) {
        const gauge = rest[i] === 'ctx' ? 'context' : rest[i]
        const values = levels(rest[i + 1])
        if ((gauge !== 'context' && gauge !== 'usage') || values === null) return { prefs, text: HUD_USAGE }
        alerts[gauge] = values
      }
      return { prefs: { ...prefs, alerts }, text: describeAlerts(alerts) }
    }
    default:
      return { prefs, text: HUD_USAGE }
  }
}

/** A stored prefs value, checked field by field; anything off falls back to the default's field. */
export function prefsFrom(stored: unknown, fallback: HudPrefs): HudPrefs {
  const value = (stored ?? {}) as Partial<HudPrefs>
  const numbers = (v: unknown) => (Array.isArray(v) && v.every(n => typeof n === 'number') ? (v as number[]) : null)
  return {
    isVisible: typeof value.isVisible === 'boolean' ? value.isVisible : fallback.isVisible,
    position: value.position === 'above' || value.position === 'below' ? value.position : fallback.position,
    alerts: {
      context: numbers(value.alerts?.context) ?? fallback.alerts.context,
      usage: numbers(value.alerts?.usage) ?? fallback.alerts.usage,
    },
  }
}

/** The last path segment: the project's name from its root. */
export function baseName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path
}

/** What the click layer over the desktop's screen has reported: for `/hud debug` and the store's `debug` key. */
export type HudProbe = {
  screen: HudHitProps | null
  /** Its region, moves and presses as last posted; null until it posts once. */
  layer: { columns: number; rows: number; moves: number; presses: number } | null
  /** The last pointer events, oldest first, as describePointer words them. */
  events: string[]
  /** Faults the engine reported for it, as `<surface> <phase>: <reason>`. */
  faults: string[]
}

/** One event: `down at 31,11 of 62×21 (left) → compact, pressed`. */
export function describePointer(p: HudHitPointer, region: { columns: number; rows: number }, press?: string): string {
  const fine = p.fine ? ` (fine ${p.fine.x.toFixed(2)},${p.fine.y.toFixed(2)})` : ''
  const button = p.button ? ` (${p.button})` : ''
  const outcome = p.type === 'down' || p.type === 'up' ? ` → ${press ? `${press}, pressed` : (p.target ?? 'no control')}` : ''
  return `${p.type} at ${p.x},${p.y}${fine} of ${region.columns}×${region.rows}${button}${outcome}`
}

/** The probe as lines of text. */
export function describeProbe(probe: HudProbe): string[] {
  const s = probe.screen
  const screen = s
    ? `Screen ${s.width} px wide (before the desktop scales it); header controls ` +
      s.targets.map(t => `${t.key} x ${Math.round(t.left)}–${Math.round(t.right)}`).join(', ')
    : 'Screen: not drawn on the desktop yet.'
  const l = probe.layer
  const layer = l
    ? `Click layer: running, ${l.columns}×${l.rows} cells, ${l.moves} pointer moves and ${l.presses} presses seen.`
    : 'Click layer: never heard from (it did not load, or has not drawn yet).'
  const faults = probe.faults.length ? probe.faults.map(f => `Fault: ${f}`) : ['Faults: none.']
  const events = probe.events.length ? ['Events:', ...probe.events] : ['Events: none yet.']
  return [screen, layer, ...faults, ...events]
}
