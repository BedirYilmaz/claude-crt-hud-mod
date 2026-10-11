// The panel as a CRT screen for the desktop app: an SVG with a dark glass,
// phosphor glow, scanlines, a vignette and a slow rolling scan band. Labels sit
// left, values flush right, gauges as segmented bars aligned between them.
// `COMPACT ▸`, `▾ MIN` (`▴ MAX` when minimal) and `✕ HIDE` are outlined controls in the header, and the screen
// says where they are across it (`targets`): it is an image, so hit.tsx, a
// click layer over the header alone, turns clicks there into presses. The
// desktop reports where a click lands across that layer exactly, but not how
// its rows meet the image's pixels, so every control shares the header's row.
// Armed, the compact control and the COMPACT line light up; while a compaction
// is queued or running it dims, and the header says so. Motion stops under
// prefers-reduced-motion. No `$` here.
import type { HudCompactRun, HudHitTarget } from '../types'
import { type Line, PALETTE, type Span, fitHeader, textOf } from './panel.js'

const FONT = 13
/** A monospace glyph's advance at FONT, close enough for SF Mono, Menlo and Consolas. */
const CHAR = FONT * 0.6
const ROW = 22
const PAD_X = 20
const HEAD = 42
const FOOT = 14
/** The widest label, `CONTEXT` or `COMPACT`, plus room. */
const LABEL_CHARS = 10
/** The header's text baseline, and the room between its controls. */
const HEAD_Y = 25
const CONTROL_GAP = 22
const HIDE = '✕ HIDE'
const COMPACT = 'COMPACT ▸'
const MIN = '▾ MIN'
const MAX = '▴ MAX'
const TITLE = '▌CLAUDE HUD█'

export type Screen = { source: string; width: number; height: number; targets: HudHitTarget[] }

export type ScreenOptions = {
  /** The markup's width in CSS pixels; the desktop scales it down to the slot. */
  width: number
  isWorking: boolean
  /** Compact was pressed once: the next press runs it. */
  isArmed?: boolean
  /** A /compact queued or running: the control rests dim. */
  compactRun?: HudCompactRun
  /** Minimal: the size control reads `▴ MAX`. */
  isMinimal?: boolean
  /** Drawn in the header left of the status, left to right: the minimal screen's cost and branch. */
  extras?: Span[][]
}

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const chars = (text: string) => [...text].length
const px = (n: number) => Number(n.toFixed(1))

function tspan(x: Span): string {
  return `<tspan fill="${PALETTE[x.tone]}"${x.bold ? ' font-weight="700"' : ''}>${esc(x.text)}</tspan>`
}

function bar(percent: number, color: string, x: number, top: number, width: number, segments: number): string {
  const filled = Math.min(segments, Math.max(0, Math.round((percent / 100) * segments)))
  const step = width / segments
  let out = ''
  for (let k = 0; k < segments; k++) {
    out += `<rect x="${px(x + k * step)}" y="${top}" width="${px(step - 2)}" height="9" rx="1" fill="${k < filled ? color : PALETTE.track}"/>`
  }
  return out
}

/** The band behind the armed COMPACT line. */
function lit(x: number, y: number, width: number, height: number, color: string): string {
  return `<rect class="lit" x="${px(x)}" y="${px(y)}" width="${px(width)}" height="${px(height)}" rx="3" fill="${color}" fill-opacity=".14" stroke="${color}" stroke-opacity=".5"/>`
}

/** How a header control reads: at rest, lit amber when armed, dim while it has nothing to do. */
type Look = 'control' | 'lit' | 'busy'

const LOOKS: Record<Look, { color: string; fill: string; stroke: string }> = {
  control: { color: PALETTE.ok, fill: '.07', stroke: '.45' },
  lit: { color: PALETTE.warn, fill: '.18', stroke: '.7' },
  busy: { color: PALETTE.dim, fill: '0', stroke: '.6' },
}

/** An outlined header control: `text` ending at `end`. */
function control(text: string, end: number, look: Look = 'control'): string {
  const width = chars(text) * CHAR
  const { color, fill, stroke } = LOOKS[look]
  return (
    `<rect class="${look}" x="${px(end - width - 6)}" y="${HEAD_Y - 14}" width="${px(width + 12)}" height="19" rx="3" fill="${color}" fill-opacity="${fill}" stroke="${color}" stroke-opacity="${stroke}"/>` +
    `<text x="${px(end)}" y="${HEAD_Y}" text-anchor="end" fill="${color}"${look === 'lit' ? ' font-weight="700"' : ''}>${esc(text)}</text>`
  )
}

const STYLE = `
text { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: ${FONT}px; white-space: pre; }
.flicker { animation: flicker 5s infinite steps(1); }
.blink { animation: blink 1.1s infinite steps(1); }
.roll { animation: roll 8s linear infinite; }
@keyframes flicker { 0%, 100% { opacity: 1 } 46% { opacity: .965 } 47% { opacity: 1 } 81% { opacity: .98 } 82% { opacity: 1 } }
@keyframes blink { 50% { opacity: 0 } }
@keyframes roll { from { transform: translateY(-60px) } to { transform: translateY(var(--h)) } }
@media (prefers-reduced-motion: reduce) { .flicker, .blink, .roll { animation: none } .roll { display: none } }
`

/** The screen at `width` CSS pixels, as tall as its lines need, and where its controls are. */
export function crtScreen(lines: readonly Line[], options: ScreenOptions): Screen {
  const W = Math.round(options.width)
  const H = HEAD + lines.length * ROW + FOOT
  const right = W - PAD_X
  const valueChars = Math.max(0, ...lines.filter(l => l.gauge).map(l => chars(textOf(l.value))))
  const barX = PAD_X + LABEL_CHARS * CHAR
  const barW = Math.max(60, right - valueChars * CHAR - 18 - barX)
  const segments = Math.max(10, Math.min(60, Math.round(barW / 9)))
  const targets: HudHitTarget[] = []

  const rows = lines
    .map((line, i) => {
      const top = HEAD + i * ROW
      const y = top + 15
      if (line.action === 'compact' && options.isArmed && !options.compactRun) {
        return (
          lit(PAD_X - 8, top + 1, right - PAD_X + 16, ROW - 2, PALETTE.warn) +
          `<text x="${PAD_X}" y="${y}" fill="${PALETTE.warn}" font-weight="700">${esc(line.label)}</text>` +
          `<text x="${right}" y="${y}" text-anchor="end" fill="${PALETTE.warn}" font-weight="700" class="blink">click again to compact</text>`
        )
      }
      const gauge = line.gauge ? bar(line.gauge.percent, PALETTE[line.gauge.tone], barX, y - 9, barW, segments) : ''
      return (
        `<text x="${PAD_X}" y="${y}" fill="${PALETTE.label}">${esc(line.label)}</text>` +
        gauge +
        `<text x="${right}" y="${y}" text-anchor="end">${line.value.map(tspan).join('')}</text>`
      )
    })
    .join('')

  // Right to left: hide, size, compact, then the status and the cost. Each target is its outline and half the gap beside it.
  const size = options.isMinimal ? MAX : MIN
  const half = (CONTROL_GAP - 6) / 2
  const hideLeft = right - chars(HIDE) * CHAR - 6
  const sizeEnd = hideLeft - CONTROL_GAP
  const sizeLeft = sizeEnd - chars(size) * CHAR - 6
  const compactEnd = sizeLeft - CONTROL_GAP
  const compactLeft = compactEnd - chars(COMPACT) * CHAR - 6
  targets.push({ key: 'compact', left: px(compactLeft - half), right: px(compactEnd + 6 + half) })
  targets.push({ key: 'size', left: px(sizeLeft - half), right: px(sizeEnd + 6 + half) })
  targets.push({ key: 'hide', left: px(hideLeft - half), right: W - 8 })
  // What does not fit beside the title gives way: a long branch is shortened, then left out, then the cost, then the status.
  const titleEnd = PAD_X + (chars(TITLE) + 2) * CHAR
  const run = options.compactRun ?? null
  const [statusText, statusColor, isBlinking] =
    run !== null
      ? [`◌ ${run === 'running' ? 'COMPACTING' : 'COMPACT QUEUED'}`, PALETTE.warn, true]
      : options.isWorking
        ? ['● WORKING', PALETTE.warn, true]
        : ['○ IDLE', PALETTE.dim, false]
  const statusX = compactLeft - 2 * CHAR
  const statusLeft = statusX - chars(statusText) * CHAR
  const status =
    statusLeft < titleEnd
      ? ''
      : `<text x="${px(statusX)}" y="${HEAD_Y}" text-anchor="end" fill="${statusColor}"${isBlinking ? ' class="blink"' : ''}>${esc(statusText)}</text>`
  const room = Math.floor((statusLeft - 2 * CHAR - titleEnd) / CHAR)
  let extras = ''
  let extraX = statusLeft - 2 * CHAR
  for (const spans of status ? fitHeader(options.extras ?? [], room, 2).reverse() : []) {
    extras = `<text x="${px(extraX)}" y="${HEAD_Y}" text-anchor="end">${spans.map(tspan).join('')}</text>` + extras
    extraX -= (chars(textOf(spans)) + 2) * CHAR
  }
  const compactLook: Look = run !== null ? 'busy' : options.isArmed ? 'lit' : 'control'

  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="--h: ${H + 60}px">` +
    `<style>${STYLE}</style>` +
    '<defs>' +
    '<radialGradient id="hud-glass" cx="50%" cy="42%" r="78%"><stop offset="0" stop-color="#0f1d14"/><stop offset="1" stop-color="#020403"/></radialGradient>' +
    '<radialGradient id="hud-vignette" cx="50%" cy="50%" r="75%"><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".62"/></radialGradient>' +
    '<linearGradient id="hud-roll" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9fffbf" stop-opacity="0"/><stop offset=".5" stop-color="#9fffbf" stop-opacity=".07"/><stop offset="1" stop-color="#9fffbf" stop-opacity="0"/></linearGradient>' +
    '<pattern id="hud-scan" width="4" height="3" patternUnits="userSpaceOnUse"><rect width="4" height="1" fill="#000" fill-opacity=".4"/></pattern>' +
    '<filter id="hud-glow" x="-5%" y="-20%" width="110%" height="140%"><feGaussianBlur stdDeviation="1.3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
    `<clipPath id="hud-screen"><rect x="4" y="4" width="${W - 8}" height="${H - 8}" rx="13"/></clipPath>` +
    '</defs>' +
    `<rect width="${W}" height="${H}" rx="16" fill="${PALETTE.bezel}"/>` +
    `<rect x="4" y="4" width="${W - 8}" height="${H - 8}" rx="13" fill="url(#hud-glass)" stroke="${PALETTE.edge}"/>` +
    '<g clip-path="url(#hud-screen)">' +
    '<g class="flicker" filter="url(#hud-glow)">' +
    `<text x="${PAD_X}" y="${HEAD_Y}" fill="${PALETTE.label}" font-weight="700">▌CLAUDE HUD<tspan class="blink">█</tspan></text>` +
    extras +
    status +
    control(COMPACT, compactEnd, compactLook) +
    control(size, sizeEnd) +
    control(HIDE, right) +
    `<line x1="${PAD_X}" y1="33" x2="${right}" y2="33" stroke="${PALETTE.dim}" stroke-dasharray="2 4"/>` +
    rows +
    '</g>' +
    `<rect width="${W}" height="${H}" fill="url(#hud-scan)"/>` +
    `<rect class="roll" width="${W}" height="60" fill="url(#hud-roll)"/>` +
    `<rect width="${W}" height="${H}" fill="url(#hud-vignette)"/>` +
    '</g>' +
    '</svg>'

  return { source, width: W, height: H, targets }
}
