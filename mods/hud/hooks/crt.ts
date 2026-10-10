// The panel as a CRT screen for the desktop app: an SVG with a dark glass,
// phosphor glow, scanlines, a vignette and a slow rolling scan band. Labels sit
// left, values flush right, gauges as segmented bars aligned between them.
// Motion stops under prefers-reduced-motion. No `$` here.
import { type Line, PALETTE, type Span, textOf } from './panel.js'

const FONT = 13
/** A monospace glyph's advance at FONT, close enough for SF Mono, Menlo and Consolas. */
const CHAR = FONT * 0.6
const ROW = 22
const PAD_X = 20
const HEAD = 42
const FOOT = 14
/** The widest label, `CONTEXT` or `PROJECT`, plus room. */
const LABEL_CHARS = 9

export type Screen = { source: string; width: number; height: number }

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

/** The screen at `width` CSS pixels, as tall as its lines need. */
export function crtScreen(lines: readonly Line[], options: { width: number; isWorking: boolean }): Screen {
  const W = Math.round(options.width)
  const H = HEAD + lines.length * ROW + FOOT
  const right = W - PAD_X
  const valueChars = Math.max(0, ...lines.filter(l => l.gauge).map(l => chars(textOf(l.value))))
  const barX = PAD_X + LABEL_CHARS * CHAR
  const barW = Math.max(60, right - valueChars * CHAR - 18 - barX)
  const segments = Math.max(10, Math.min(32, Math.round(barW / 9)))

  const rows = lines
    .map((line, i) => {
      const y = HEAD + i * ROW + 15
      const gauge = line.gauge ? bar(line.gauge.percent, PALETTE[line.gauge.tone], barX, y - 9, barW, segments) : ''
      return (
        `<text x="${PAD_X}" y="${y}" fill="${PALETTE.label}">${esc(line.label)}</text>` +
        gauge +
        `<text x="${right}" y="${y}" text-anchor="end">${line.value.map(tspan).join('')}</text>`
      )
    })
    .join('')

  const status = options.isWorking
    ? `<text x="${right}" y="25" text-anchor="end" fill="${PALETTE.warn}" class="blink">● WORKING</text>`
    : `<text x="${right}" y="25" text-anchor="end" fill="${PALETTE.dim}">○ IDLE</text>`

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
    `<text x="${PAD_X}" y="25" fill="${PALETTE.label}" font-weight="700">▌CLAUDE HUD<tspan class="blink">█</tspan></text>` +
    status +
    `<line x1="${PAD_X}" y1="33" x2="${right}" y2="33" stroke="${PALETTE.dim}" stroke-dasharray="2 4"/>` +
    rows +
    '</g>' +
    `<rect width="${W}" height="${H}" fill="url(#hud-scan)"/>` +
    `<rect class="roll" width="${W}" height="60" fill="url(#hud-roll)"/>` +
    `<rect width="${W}" height="${H}" fill="url(#hud-vignette)"/>` +
    '</g>' +
    '</svg>'

  return { source, width: W, height: H }
}
