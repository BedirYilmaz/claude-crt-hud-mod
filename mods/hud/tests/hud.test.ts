import { type MockClock, type Mounted, describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement, RenderPropsOf, SessionUsage, TurnStepInput, TurnStepResult } from 'claude-code'

import type { HudHitProps, HudPrefs } from '../types'
import { alertsFor } from '../hooks/alerts.js'
import { crtScreen } from '../hooks/crt.js'
import { type Line, type View, PALETTE, buildPanel, fitPanel, modelName, panelText, span, textOf, tokens } from '../hooks/panel.js'
import { lastCacheTtl, parseGitStatus, prefsFrom, runHudCommand } from '../hooks/parse.js'

const NOW = Date.parse('2026-10-09T10:00:00Z')
const MIN = 60_000
const iso = (ms: number) => new Date(ms).toISOString()

const PREFS: HudPrefs = { isVisible: true, position: 'above', alerts: { context: [], usage: [] } }

const VIEW: View = {
  project: 'my-repo',
  repo: { branch: 'feat/hud', dirty: 3 },
  usage: {
    tokens: 76_000,
    window: 200_000,
    percent: 38,
    usd: 2.14,
    limits: [
      { kind: 'seven_day', percent: 61, resetsAt: NOW + (3 * 24 + 4) * 60 * MIN },
      { kind: 'five_hour', percent: 42, resetsAt: NOW + 134 * MIN },
    ],
  },
  model: { id: 'claude-opus-5-5', effort: 'high' },
  compact: { window: 200_000, at: 160_000 },
  cache: { lastRequestAt: NOW - 8 * MIN, ttl: '1h', isTtlKnown: true, tokens: 76_500 },
  activity: { tools: { t1: 'Bash' }, agents: 2 },
  now: NOW,
}

const GIT = [
  '# branch.oid 1234567890abcdef1234567890abcdef12345678',
  '# branch.head feat/hud',
  '# branch.upstream origin/feat/hud',
  '# branch.ab +0 -0',
  '1 .M N... 100644 100644 100644 aaa aaa src/a.ts',
  '1 A. N... 000000 100644 100644 000 bbb src/b.ts',
  '? notes.md',
  '',
].join('\n')

const rows = (lines: readonly Line[]) => lines.map(l => [l.label, textOf(l.value)])
const line = (lines: readonly Line[], key: string) => lines.find(l => l.key === key)!

describe('panel', () => {
  test('lists each part on its own line: label left, value right', () => {
    const lines = buildPanel(VIEW)
    expect(rows(lines)).toEqual([
      ['MODEL', 'Opus 5.5 · high'],
      ['PROJECT', 'my-repo'],
      ['BRANCH', 'feat/hud ±3'],
      ['CONTEXT', '38% 76k/200k'],
      ['COMPACT', 'in 84k'],
      ['5-HOUR', '42% ↻2h14m'],
      ['7-DAY', '61% ↻3d4h'],
      ['CACHE', '52m'],
      ['COST', '$2.14'],
      ['RUNNING', 'Bash · 2 agents'],
    ])
    expect(line(lines, 'compact').action).toBe('compact')
    expect(lines.filter(l => l.gauge).map(l => [l.key, l.gauge!.percent, l.gauge!.tone])).toEqual([
      ['context', 38, 'ok'],
      ['five_hour', 42, 'ok'],
      ['seven_day', 61, 'ok'],
    ])
  })

  test('tones follow meaning and level', () => {
    const calm = buildPanel(VIEW)
    expect(line(calm, 'model').value[0]).toEqual({ text: 'Opus 5.5', tone: 'model', bold: true })
    expect(line(calm, 'branch').value[0]!.tone).toBe('dirty')
    expect(line(calm, 'cost').value[0]!.tone).toBe('cost')
    const hot = buildPanel({
      ...VIEW,
      repo: { branch: 'main', dirty: 0 },
      usage: { ...VIEW.usage, tokens: 172_000, percent: 86, limits: [{ kind: 'five_hour', percent: 81, resetsAt: null }] },
      cache: { ...VIEW.cache, lastRequestAt: NOW - 2 * 60 * MIN, tokens: 172_000 },
    })
    expect(line(hot, 'branch').value[0]!.tone).toBe('clean')
    expect(line(hot, 'context').gauge!.tone).toBe('crit')
    expect(line(hot, 'five_hour').gauge!.tone).toBe('warn')
    expect(textOf(line(hot, 'cache').value)).toBe('expired · re-caches 172k')
    expect(line(hot, 'cache').level).toBe('warn')
  })

  test('drops lines lowest rank first when short of room; warnings and gauges stay longer', () => {
    const lines = buildPanel(VIEW)
    expect(fitPanel(lines, 6).map(l => l.key)).toEqual(['model', 'project', 'context', 'compact', 'five_hour', 'cache'])
    expect(fitPanel(lines, 2).map(l => l.key)).toEqual(['model', 'project', 'context', 'five_hour'])
    const cold = buildPanel({ ...VIEW, cache: { ...VIEW.cache, lastRequestAt: NOW - 2 * 60 * MIN } })
    expect(fitPanel(cold, 5).map(l => l.key)).toEqual(['model', 'project', 'context', 'five_hour', 'cache'])
  })

  test('marks a guessed cache TTL and leaves out what is not known yet', () => {
    const guessed = buildPanel({ ...VIEW, cache: { ...VIEW.cache, ttl: '5m', isTtlKnown: false, lastRequestAt: NOW - MIN } })
    expect(textOf(line(guessed, 'cache').value)).toBe('~4m')
    const fresh = buildPanel({
      ...VIEW,
      repo: null,
      usage: { tokens: null, window: 200_000, percent: null, usd: null, limits: [] },
      cache: { lastRequestAt: null, ttl: '5m', isTtlKnown: false, tokens: null },
      activity: { tools: {}, agents: 0 },
    })
    expect(rows(fresh)).toEqual([
      ['MODEL', 'Opus 5.5 · high'],
      ['PROJECT', 'my-repo'],
      ['CONTEXT', '–/200k'],
      ['COMPACT', 'at 160k'],
    ])
    expect(panelText(fresh)).toBe('MODEL Opus 5.5 · high\nPROJECT my-repo\nCONTEXT [0%] –/200k\nCOMPACT at 160k')
  })

  test('keeps the COMPACT line, and its control, whatever is known of auto-compaction', () => {
    const compactOf = (compact: View['compact']) => textOf(line(buildPanel({ ...VIEW, compact }), 'compact').value)
    expect([compactOf(null), compactOf({ window: 200_000, at: null })]).toEqual(['–', 'auto off'])
    expect(line(buildPanel({ ...VIEW, compact: null }), 'compact').action).toBe('compact')
  })

  test('says on the COMPACT line when a compaction is queued or running', () => {
    const runOf = (compactRun: View['compactRun']) => textOf(line(buildPanel({ ...VIEW, compactRun }), 'compact').value)
    expect([runOf('queued'), runOf('running'), runOf(null)]).toEqual(['queued · runs when idle', 'compacting…', 'in 84k'])
  })

  test('formats models, tokens and countdowns', () => {
    expect(modelName('claude-fable-5-1')).toBe('Fable 5.1')
    expect(modelName('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5 1M')
    expect([tokens(850), tokens(8_400), tokens(999_600), tokens(1_000_000)]).toEqual(['850', '8.4k', '1M', '1M'])
    expect([span(30_000), span(14 * MIN), span(125 * MIN), span(76 * 60 * MIN), span((73 * 60 + 45) * MIN)]).toEqual(['<1m', '14m', '2h05m', '3d4h', '3d2h'])
  })

  test('a plan window past its reset says so instead of its old figure', () => {
    const lines = buildPanel({ ...VIEW, now: NOW + 135 * MIN })
    expect(textOf(line(lines, 'five_hour').value)).toBe('reset')
    expect(line(lines, 'five_hour').gauge?.percent).toBe(0)
    expect(textOf(line(lines, 'seven_day').value)).toBe('61% ↻3d2h')
  })

  test('the compact distance counts what the next request sends, the last output too', () => {
    expect(textOf(line(buildPanel(VIEW), 'compact').value)).toBe('in 84k')
    expect(textOf(line(buildPanel({ ...VIEW, cache: { ...VIEW.cache, tokens: 90_000 } }), 'compact').value)).toBe('in 70k')
    expect(textOf(line(buildPanel({ ...VIEW, cache: { ...VIEW.cache, tokens: null } }), 'compact').value)).toBe('in 84k')
  })
})

describe('crt screen', () => {
  test('draws every line on a scanlined glass, sized to its lines', () => {
    const lines = buildPanel(VIEW)
    const screen = crtScreen(lines, { width: 600, isWorking: false })
    expect([screen.width, screen.height]).toEqual([600, 42 + 10 * 22 + 14])
    for (const text of ['MODEL', 'Opus 5.5', 'CONTEXT', '↻2h14m', '$2.14', '○ IDLE', 'url(#hud-scan)', 'url(#hud-glow)', 'prefers-reduced-motion']) {
      expect(screen.source).toContain(text)
    }
    expect(crtScreen(lines, { width: 600, isWorking: true }).source).toContain('● WORKING')
  })

  test('puts COMPACT and HIDE side by side in the header, says where they span, and lights compact when armed', () => {
    const lines = buildPanel(VIEW)
    const screen = crtScreen(lines, { width: 600, isWorking: false })
    const [compact, hide] = screen.targets
    expect(screen.targets.map(t => t.key)).toEqual(['compact', 'hide'])
    // Right to left with no overlap, hide reaching the screen's edge, the status left of both.
    expect(hide!.right).toBe(592)
    expect(compact!.right).toBeLessThanOrEqual(hide!.left)
    expect(compact!.right - compact!.left).toBeGreaterThan(9 * 7.8)
    const statusX = Number(/x="([\d.]+)"[^>]*>○ IDLE/.exec(screen.source)?.[1])
    expect(statusX).toBeLessThan(compact!.left)
    expect(screen.source.match(/class="control"/g)).toHaveLength(2)
    expect(screen.source).toContain('>COMPACT ▸</text>')
    expect(screen.source).toContain('>✕ HIDE</text>')
    expect(screen.source).not.toContain('class="lit"')
    expect(screen.source).toContain('in </tspan>')
    const armed = crtScreen(lines, { width: 600, isWorking: false, isArmed: true }).source
    // The compact control and the COMPACT line light up; hide stays as it was.
    expect(armed.match(/class="lit"/g)).toHaveLength(2)
    expect(armed.match(/class="control"/g)).toHaveLength(1)
    expect(armed).toContain('click again to compact')
    expect(armed).not.toContain('in </tspan>')
  })

  test('dims the compact control while a compaction is queued or running, and says so in the header', () => {
    const running = crtScreen(buildPanel({ ...VIEW, compactRun: 'running' }), { width: 600, isWorking: true, isArmed: true, compactRun: 'running' })
    // Neither armed nor working: the compaction is what is going on.
    expect(running.source).toContain('◌ COMPACTING')
    expect(running.source).not.toContain('● WORKING')
    expect(running.source).not.toContain('class="lit"')
    expect(running.source.match(/class="busy"/g)).toHaveLength(1)
    expect(running.source.match(/class="control"/g)).toHaveLength(1)
    expect(running.source).toContain('compacting…')
    expect(running.targets.map(t => t.key)).toEqual(['compact', 'hide'])
    const queued = crtScreen(buildPanel({ ...VIEW, compactRun: 'queued' }), { width: 600, isWorking: false, compactRun: 'queued' })
    expect(queued.source).toContain('◌ COMPACT QUEUED')
  })

  test('aligns the gauges in one column and escapes what it is given', () => {
    const screen = crtScreen(buildPanel(VIEW), { width: 600, isWorking: false })
    const starts = [...screen.source.matchAll(/<\/text><rect x="([\d.]+)"/g)].map(m => m[1])
    expect(starts).toHaveLength(3)
    expect(new Set(starts).size).toBe(1)
    const odd = crtScreen(buildPanel({ ...VIEW, project: 'a<b>&"c' }), { width: 600, isWorking: false })
    expect(odd.source).toContain('a&lt;b&gt;&amp;&quot;c')
    expect(odd.source).not.toContain('a<b>')
  })
})

describe('parse', () => {
  test('git status: branch, detached head and dirty paths', () => {
    expect(parseGitStatus(GIT)).toEqual({ branch: 'feat/hud', dirty: 3 })
    expect(parseGitStatus('# branch.oid abcdef1234567\n# branch.head (detached)\n')).toEqual({ branch: '@abcdef1', dirty: 0 })
  })

  test('the transcript names the cache tier of the main thread only', () => {
    const entry = (tier: '1h' | '5m', isSidechain = false) =>
      JSON.stringify({
        type: 'assistant',
        isSidechain,
        message: { usage: { cache_creation: { ephemeral_1h_input_tokens: tier === '1h' ? 500 : 0, ephemeral_5m_input_tokens: tier === '5m' ? 500 : 0 } } },
      })
    expect(lastCacheTtl([entry('5m'), entry('1h'), '{"type":"user"}', ''].join('\n'))).toBe('1h')
    expect(lastCacheTtl([entry('5m'), entry('1h', true)].join('\n'))).toBe('5m')
    expect(lastCacheTtl('{"type":"user"}\n')).toBeNull()
  })

  test('/hud toggles, moves and sets alerts', () => {
    expect(runHudCommand('', PREFS)).toEqual({ prefs: { ...PREFS, isVisible: false }, text: 'HUD off' })
    expect(runHudCommand('below', { ...PREFS, isVisible: false }).text).toBe('HUD on, below the prompt')
    const set = runHudCommand('alerts context 90,80 usage 95', PREFS)
    expect(set.prefs.alerts).toEqual({ context: [80, 90], usage: [95] })
    expect(set.text).toBe('Alerts: context 80%, 90% · usage 95%')
    expect(runHudCommand('alerts context 120', PREFS).prefs).toBe(PREFS)
    expect(runHudCommand('alerts off', set.prefs).text).toBe('Alerts off')
    expect(prefsFrom({ position: 'sideways', isVisible: false }, PREFS)).toEqual({ ...PREFS, isVisible: false })
  })

  test('alerts fire once per threshold and re-arm 5 points below', () => {
    const alerts = { context: [80, 90], usage: [] }
    const at = (percent: number) => ({ ...VIEW.usage, percent })
    const first = alertsFor(alerts, {}, at(91), NOW)
    expect(first.message).toBe('Context at 91%')
    expect(first.fired.context).toEqual([80, 90])
    expect(alertsFor(alerts, first.fired, at(92), NOW).message).toBeNull()
    const dropped = alertsFor(alerts, first.fired, at(84), NOW)
    expect(dropped.fired.context).toEqual([80])
    expect(alertsFor(alerts, dropped.fired, at(90), NOW).message).toBe('Context at 90%')
  })
})

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 20,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
} satisfies RenderPropsOf['AbovePrompt']

const HINT = { isDraft: false, isWorking: false, hint: '? for shortcuts' } satisfies RenderPropsOf['PromptHint']

const USAGE: SessionUsage = {
  startedAt: NOW - 30 * MIN,
  context: { tokens: 76_000, window: 200_000, percent: 38 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 42, resetsAt: iso(NOW + 134 * MIN) },
    { kind: 'seven_day', percentUsed: 61, resetsAt: iso(NOW + (3 * 24 + 4) * 60 * MIN) },
  ],
  cost: { usd: 2.14 },
}

/**
 * The machine beneath the plugins: a repo at /work/my-repo, one terminal attached.
 * Given a clock, `/compact` waits `queuedMs` on it, as it does for the session
 * to go idle, and a compaction takes `compactMs`.
 */
function world(on: On, gitCalls: string[][] = [], commands: string[] = [], timing?: { clock: MockClock; queuedMs: number; compactMs: number }) {
  let live: SessionUsage = USAGE
  mock.store(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('classic.SessionStart', () => ({}))
  on('classic.Stop', () => ({}))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.run', { command: 'compact' }, async ($, e) => {
    commands.push(e.command)
    if (timing) await timing.clock.sleep(timing.queuedMs)
    return { text: 'Compacted.' }
  })
  on('session.compact', async ($, e) => {
    if (timing) await timing.clock.sleep(timing.compactMs)
    return { messages: e.messages }
  })
  // The engine's own drawing: an empty band, and the hint line under the prompt.
  on('ui.render', ($, e) =>
    (e.component === 'PromptHint' ? h('Text', { dimColor: true }, e.props.hint) : h('Box', {})) as RenderElement,
  )
  const breakdown = { isAutoCompactEnabled: true, autoCompactThreshold: 160_000 }
  on('session.usage', ($, e) => ({ value: (e.breakdown ? { ...live, context: { ...live.context, breakdown } } : live) as SessionUsage }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('settings.read', () => ({ value: { effortLevel: 'high' } }))
  on('session.surfaces', () => ({ value: ['terminal' as const] }))
  on('session.cwd', () => ({ value: '/work/my-repo' }))
  on('session.repo', () => ({ value: { root: '/work/my-repo', remote: null, internal: false, name: null } }))
  on('agent.list', () => ({ value: [] }))
  on('process.run', ($, e) => {
    gitCalls.push([...e.argv])
    return { value: { exitCode: 0, stdout: GIT, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  /** What `$.session.usage()` answers from now on, as the engine's figures move. */
  return { setUsage: (u: SessionUsage) => void (live = u) }
}

/** One main-thread response with these token counts. */
function answering(on: On, used: { input: number; read: number; written: number; output: number }) {
  on('turn.step', async function* (_$, e) {
    const usage = { input_tokens: used.input, cache_read_input_tokens: used.read, cache_creation_input_tokens: used.written, output_tokens: used.output, model: e.model }
    const result: TurnStepResult = { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as TurnStepResult['stopReason'], usage }
    return result
  })
}

async function step($: { turn: { step: (input: TurnStepInput) => AsyncIterable<unknown> & { result: Promise<TurnStepResult> } } }, index = 0) {
  const stream = $.turn.step({ turnId: 't1', index, model: 'claude-opus-5-5', effort: 'high', messageCount: 2 })
  for await (const chunk of stream) void chunk
  await stream.result
}

async function alt(ui: Mounted<'desktop', 'AbovePrompt'>): Promise<string> {
  return String((await ui.find({ type: 'Svg' }))?.props.alt)
}

type Found = { text: string; props: Record<string, unknown> }
type Drawing = { findAll: (q: { type: string }) => Promise<Found[]>; find: (q: { type?: string; key?: string; text?: string | RegExp }) => Promise<Found | undefined> }

/** What a drawing shows: its texts in order, and the readable text of any CRT screen in it. */
async function seen(ui: Drawing): Promise<string> {
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('')
  const screens = (await ui.findAll({ type: 'Svg' })).map(x => `${String(x.props.alt)}\n${String(x.props.source)}`)
  return [texts, ...screens].join('\n')
}

/** The click layer's grid in the tests: 125 columns across the screen, the header's 2 rows. */
const LAYER = { columns: 125, rows: 2 }

/** Moves the pointer to, or clicks, a header control, through the click layer; `row` is 0 or 1. */
async function pointAt(ui: Mounted<'desktop', 'AbovePrompt'>, key: string, type: 'enter' | 'move' | 'down' | 'up', row = 0) {
  const hit = (await ui.find({ key: 'hit' }))!.props.props as HudHitProps
  const target = hit.targets.find(t => t.key === key)!
  const x = Math.floor(((target.left + target.right) / 2 / hit.width) * LAYER.columns)
  await ui.pointer(type === 'down' || type === 'up' ? { type, x, y: row, button: 'left', in: 'hit' } : { type, x, y: row, in: 'hit' })
}

/** A click on a control of the screen: a down and an up over it, through the click layer. */
async function click(ui: Mounted<'desktop', 'AbovePrompt'>, key: string, row = 0) {
  await pointAt(ui, key, 'down', row)
  await pointAt(ui, key, 'up', row)
}

describe('in the engine', () => {
  test('a full-width dark panel on the terminal, a full-width CRT screen on the desktop, and git stays read-only', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const gitCalls: string[][] = []
    world(on, gitCalls)
    await $.session.start({ cwd: '/work/my-repo', surface: 'terminal', isInteractive: true })
    await $.session.measure({ ...USAGE, changed: ['context', 'rateLimits', 'cost'] })
    await clock.advance(100)

    const terminal = await $.ui.mount({ plugin: 'hud', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    const shown = await seen(terminal)
    for (const text of ['▌CLAUDE HUD', 'MODELOpus 5.5 · high', 'PROJECTmy-repo', 'BRANCHfeat/hud ±3', '38% 76k/200k', 'in 84k', '42% ↻2h14m', '61% ↻3d4h', 'COST$2.14']) {
      expect(shown).toContain(text)
    }
    expect((await terminal.find({ type: 'Text', text: 'Opus 5.5' }))?.props).toMatchObject({ color: PALETTE.model, bold: true })
    expect((await terminal.find({ key: 'compact' }))?.props.label).toBe('COMPACT ▸')
    expect((await terminal.find({ key: 'hide' }))?.props.label).toBe('✕')
    // As wide as the band, less its indent.
    expect((await terminal.findAll({ type: 'Box' })).find(b => b.props.borderStyle === 'round')?.props.width).toBe(118)
    await terminal.unmount()

    const desktop = await $.ui.mount({ plugin: 'hud', surface: 'desktop', component: 'AbovePrompt', props: BAND })
    const screen = await desktop.find({ type: 'Svg' })
    expect(String(screen?.props.alt)).toContain('CONTEXT [38%] 38% 76k/200k')
    expect(String(screen?.props.source)).toContain('Opus 5.5')
    // No size of its own: the desktop fits the markup, a little wider than the band, to the band.
    expect([screen?.props.width, screen?.props.height, screen?.props.isInteractive]).toEqual([undefined, undefined, undefined])
    expect(String(screen?.props.source)).toMatch(/^<svg [^>]*width="1000"/)
    const layer = await desktop.find({ key: 'hit' })
    expect(layer?.type).toBe('Client')
    expect((layer?.props.props as HudHitProps).targets.map(t => t.key)).toEqual(['compact', 'hide'])
    // The controls are the screen's own: no buttons under it.
    expect(await desktop.find({ type: 'Button' })).toBeUndefined()

    expect(gitCalls).toEqual([['git', '--no-optional-locks', 'status', '--porcelain=v2', '--branch']])
  })

  test('compact runs /compact on a second press within 5 s, on either surface', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const commands: string[] = []
    world(on, [], commands)
    await $.session.start({ cwd: '/work/my-repo', surface: 'terminal', isInteractive: true })
    await $.session.measure({ ...USAGE, changed: ['context', 'rateLimits', 'cost'] })

    const terminal = await $.ui.mount({ plugin: 'hud', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    await terminal.press({ key: 'compact' })
    expect(commands).toEqual([])
    expect((await terminal.find({ key: 'compact' }))?.props.label).toBe('CONFIRM ▸')
    await clock.advance(5_200)
    expect((await terminal.find({ key: 'compact' }))?.props.label).toBe('COMPACT ▸')
    await terminal.press({ key: 'compact' })
    await clock.advance(600)
    await terminal.press({ key: 'compact' })
    expect(commands).toEqual(['compact'])
    await terminal.unmount()

    const desktop = await $.ui.mount({ plugin: 'hud', surface: 'desktop', component: 'AbovePrompt', props: BAND })
    const source = async () => String((await desktop.find({ type: 'Svg' }))?.props.source)
    // The COMPACT label on the screen, through the click layer: a click is a down and an up, one press.
    await desktop.resize({ ...LAYER, in: 'hit' })
    await clock.advance(600)
    await pointAt(desktop, 'compact', 'enter')
    await pointAt(desktop, 'compact', 'move')
    await pointAt(desktop, 'compact', 'down')
    await pointAt(desktop, 'compact', 'up')
    expect(await source()).toContain('click again to compact')
    expect(commands).toEqual(['compact'])
    // A double-click is not a confirmation.
    await clock.advance(100)
    await click(desktop, 'compact')
    expect(commands).toEqual(['compact'])
    // The header's second row is the same control: only the column counts.
    await clock.advance(500)
    await pointAt(desktop, 'compact', 'down', 1)
    expect(commands).toEqual(['compact', 'compact'])
    expect(await source()).not.toContain('click again to compact')
    const debug = String(
      (await $.command.run({ command: 'hud', args: 'debug', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })).text,
    )
    expect(debug).toContain('Screen 1000 px wide')
    expect(debug).toContain(`Click layer: running, ${LAYER.columns}×${LAYER.rows} cells, 1 pointer moves and 3 presses seen.`)
    expect(debug).toContain('Faults: none.')
    expect(debug).toMatch(/enter at \d+,0 of 125×2\n/)
    expect(debug).toMatch(/down at \d+,0 of 125×2 \(left\) → compact, pressed/)
    expect(debug).toMatch(/up at \d+,0 of 125×2 \(left\) → compact\n/)
    expect(debug).toMatch(/down at \d+,1 of 125×2 \(left\) → compact, pressed/)
  })

  test('a quick click still presses when the surface kept only the post of its up', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const commands: string[] = []
    world(on, [], commands)
    await $.session.start({ cwd: '/work/my-repo', surface: 'terminal', isInteractive: true })
    await $.session.measure({ ...USAGE, changed: ['context', 'rateLimits', 'cost'] })
    const desktop = await $.ui.mount({ plugin: 'hud', surface: 'desktop', component: 'AbovePrompt', props: BAND })
    const source = async () => String((await desktop.find({ type: 'Svg' }))?.props.source)
    await desktop.resize({ ...LAYER, in: 'hit' })
    // The down's post (the press) was replaced by the up's in the same frame: the up carries the count.
    const post = (presses: number, type: string) =>
      desktop.post({ ...LAYER, moves: 0, presses, pressed: 'compact', pointer: { type, x: 80, y: 0, fine: null, button: null, target: 'compact' } }, { in: 'hit' })
    await post(100, 'up')
    expect(await source()).toContain('click again to compact')
    // A later post with the same count is no new press.
    await clock.advance(600)
    await post(100, 'leave')
    expect(commands).toEqual([])
    await post(101, 'up')
    expect(commands).toEqual(['compact'])
  })

  test('compact waits while a compaction is queued or running, and the screen says so', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const commands: string[] = []
    const toasts: string[] = []
    world(on, [], commands, { clock, queuedMs: 10_000, compactMs: 20_000 })
    on('ui.toast', ($, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    await $.session.start({ cwd: '/work/my-repo', surface: 'terminal', isInteractive: true })
    await $.session.measure({ ...USAGE, changed: ['context', 'rateLimits', 'cost'] })
    const terminal = await $.ui.mount({ plugin: 'hud', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    const desktop = await $.ui.mount({ plugin: 'hud', surface: 'desktop', component: 'AbovePrompt', props: BAND })
    const screen = async () => {
      const svg = await desktop.find({ type: 'Svg' })
      return `${String(svg?.props.alt)}\n${String(svg?.props.source)}`
    }

    // Confirmed while Claude works: /compact waits its turn, and presses meanwhile queue nothing more.
    await desktop.resize({ ...LAYER, in: 'hit' })
    await click(desktop, 'compact')
    await clock.advance(600)
    await click(desktop, 'compact')
    expect(commands).toEqual(['compact'])
    expect(await screen()).toContain('◌ COMPACT QUEUED')
    expect(await screen()).toContain('COMPACT queued · runs when idle')
    expect(await terminal.find({ key: 'compact' })).toBeUndefined()
    expect(await seen(terminal)).toContain('COMPACT ◌')
    await click(desktop, 'compact')
    await clock.advance(600)
    await click(desktop, 'compact')
    await pointAt(desktop, 'compact', 'down')
    expect(commands).toEqual(['compact'])
    expect(toasts).toEqual(Array(3).fill('/compact is queued: it runs when Claude is idle.'))
    await clock.advance(10_000)
    expect(await screen()).toContain('○ IDLE')
    expect((await terminal.find({ key: 'compact' }))?.props.label).toBe('COMPACT ▸')

    // Any compaction of the conversation, auto-compaction too, holds the control while it runs.
    const messages = [{ role: 'user' as const, text: 'Make the HUD.', toolUses: [] }]
    const auto = $.session.compact({ trigger: 'auto', messages })
    await clock.advance(100)
    expect(await screen()).toContain('◌ COMPACTING')
    expect(await screen()).toContain('COMPACT compacting…')
    await clock.advance(600)
    await pointAt(desktop, 'compact', 'down')
    expect(commands).toEqual(['compact'])
    expect(toasts.at(-1)).toBe('Already compacting.')
    await clock.advance(20_000)
    await auto
    expect(await screen()).toContain('COMPACT in 84k')

    // Summarizing ahead of time, in the background, changes nothing on screen.
    const ahead = $.session.compact({ trigger: 'precompute', messages })
    await clock.advance(100)
    expect(await screen()).not.toContain('COMPACTING')
    await clock.advance(20_000)
    await ahead
  })

  test('right after a compaction the COMPACT line still shows, with the threshold', async ($, on) => {
    mock.clock(on, { now: NOW })
    world(on)
    await $.session.start({ cwd: '/work/my-repo', surface: 'terminal', isInteractive: true })
    await $.session.measure({ ...USAGE, context: { window: 200_000 }, changed: ['context'] })
    const desktop = await $.ui.mount({ plugin: 'hud', surface: 'desktop', component: 'AbovePrompt', props: BAND })
    expect(String((await desktop.find({ type: 'Svg' }))?.props.alt)).toContain('COMPACT at 160k')
    expect(((await desktop.find({ key: 'hit' }))?.props.props as HudHitProps).targets.map(t => t.key)).toContain('compact')
  })

  test('hide puts the panel away for the session; /hud brings it back', async ($, on) => {
    mock.clock(on, { now: NOW })
    world(on)
    await $.session.start({ cwd: '/work/my-repo', surface: 'terminal', isInteractive: true })
    const run = (args: string) =>
      $.command.run({ command: 'hud', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

    const terminal = await $.ui.mount({ plugin: 'hud', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    await terminal.press({ key: 'hide' })
    expect(await seen(terminal)).not.toContain('CLAUDE HUD')
    expect((await run('')).text).toBe('HUD on, above the prompt')
    expect(await seen(terminal)).toContain('CLAUDE HUD')

    // `✕ HIDE` on the screen, through the click layer, on either row of the header.
    const desktop = await $.ui.mount({ plugin: 'hud', surface: 'desktop', component: 'AbovePrompt', props: BAND })
    await desktop.resize({ ...LAYER, in: 'hit' })
    await pointAt(desktop, 'hide', 'down')
    expect(await desktop.find({ type: 'Svg' })).toBeUndefined()
    expect(await seen(terminal)).not.toContain('CLAUDE HUD')
    expect((await run('on')).text).toBe('HUD on, above the prompt')
    expect(await desktop.find({ type: 'Svg' })).toBeDefined()
    await desktop.resize({ ...LAYER, in: 'hit' })
    await pointAt(desktop, 'hide', 'down', 1)
    expect(await desktop.find({ type: 'Svg' })).toBeUndefined()
    expect((await run('')).text).toBe('HUD on, above the prompt')
  })

  test(
    'a mask mod rewrites the one project value, and every surface follows it',
    {
      plugins: [
        {
          name: 'mask',
          register(on) {
            on('state.set', { plugin: 'hud', key: 'project' }, ($, e, next) => next({ ...e, value: '▒▒▒' }))
          },
        },
      ],
    },
    async ($, on) => {
      const clock = mock.clock(on, { now: NOW })
      world(on)
      await $.session.start({ cwd: '/work/my-repo', surface: 'terminal', isInteractive: true })
      await clock.advance(100)
      for (const surface of ['terminal', 'desktop'] as const) {
        const shown = await seen(await $.ui.mount({ plugin: 'hud', surface, component: 'AbovePrompt', props: BAND }))
        expect(shown).toContain('▒▒▒')
        expect(shown).not.toContain('my-repo')
      }
    },
  )

  test('/hud below moves the panel under the prompt, /hud off hides it', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    world(on)
    await $.session.start({ cwd: '/work/my-repo', surface: 'terminal', isInteractive: true })
    await clock.advance(100)
    const run = (args: string) =>
      $.command.run({ command: 'hud', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
    expect((await run('below')).text).toBe('HUD on, below the prompt')
    const band = await $.ui.mount({ plugin: 'hud', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await seen(band)).not.toContain('Opus')
    const hint = await $.ui.mount({ plugin: 'hud', surface: 'desktop', component: 'PromptHint', props: HINT, viewport: { columns: 120, rows: 40 } })
    expect(await seen(hint)).toContain('MODEL Opus 5.5 · high')
    expect(await seen(hint)).toContain('? for shortcuts')
    expect((await run('off')).text).toBe('HUD off')
    expect(await seen(hint)).not.toContain('Opus')
  })

  test('a main-thread request starts the cache clock, which turns into the re-cache cost', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    world(on)
    const response: TurnStepResult = {
      turnId: 't1',
      index: 0,
      answer: 'done',
      toolUses: [],
      stopReason: 'end_turn' as TurnStepResult['stopReason'],
      usage: { input_tokens: 10, output_tokens: 490, cache_read_input_tokens: 70_000, cache_creation_input_tokens: 5_500, model: 'claude-opus-5-5' },
    }
    on('turn.step', async function* () {
      return response
    })
    await $.session.start({ cwd: '/work/my-repo', surface: 'terminal', isInteractive: true })
    const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 2 })
    for await (const chunk of stream) void chunk
    await stream.result
    const ui = await $.ui.mount({ plugin: 'hud', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await seen(ui)).toContain('Opus 5.5 · xhigh')
    expect(await seen(ui)).toContain('CACHE~5m')
    await clock.advance(5 * MIN + 2_000)
    expect(await seen(ui)).toContain('CACHEexpired · re-caches 76k')
  })

  test('the effort follows each request as it goes out, so a switch never leaves the old level', async ($, on) => {
    mock.clock(on, { now: NOW })
    world(on)
    let ui: Drawing | undefined
    const during: string[] = []
    on('turn.step', async function* (_$, e) {
      if (ui) during.push(await seen(ui))
      const result: TurnStepResult = { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as TurnStepResult['stopReason'], usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: e.model } }
      return result
    })
    await $.session.start({ cwd: '/work/my-repo', surface: 'terminal', isInteractive: true })
    ui = await $.ui.mount({ plugin: 'hud', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    const step = async (index: number, effort?: TurnStepInput['effort']) => {
      const stream = $.turn.step({ turnId: 't1', index, model: 'claude-opus-5-5', ...(effort ? { effort } : {}), messageCount: 2 })
      for await (const chunk of stream) void chunk
      await stream.result
    }
    await step(0, 'xhigh')
    expect(during[0]).toContain('Opus 5.5 · xhigh')
    expect(await seen(ui)).toContain('Opus 5.5 · xhigh')
    await step(1, 'medium')
    expect(during[1]).toContain('Opus 5.5 · medium')
    expect(await seen(ui)).toContain('Opus 5.5 · medium')
    await step(2)
    expect(await seen(ui)).not.toContain('medium')
    expect(await seen(ui)).not.toContain('xhigh')
  })

  test('a resumed session shows at once whether its cache outlived the pause', async ($, on) => {
    mock.clock(on, { now: NOW })
    world(on)
    await $.session.start({ cwd: '/work/my-repo', surface: 'terminal', isInteractive: true })
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 600, context_tokens: 172_000, prompt_cache_likely_expired: false })
    const ui = await $.ui.mount({ plugin: 'hud', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await seen(ui)).toContain('CACHE50m')
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 4000, context_tokens: 172_000, prompt_cache_likely_expired: true })
    expect((await ui.find({ type: 'Text', text: 'expired' }))?.props.color).toBe(PALETTE.warn)
    expect(await seen(ui)).toContain('CACHEexpired · re-caches 172k')
  })

  test('context, cost and the compact distance move with each response, not only at the turn end', async ($, on) => {
    mock.clock(on, { now: NOW })
    const { setUsage } = world(on)
    answering(on, { input: 2, read: 100_000, written: 10_000, output: 6_000 })
    await $.session.start({ cwd: '/work/my-repo', surface: 'terminal', isInteractive: true })
    await $.session.measure({ ...USAGE, changed: ['context', 'rateLimits', 'cost'] })
    const desktop = await $.ui.mount({ plugin: 'hud', surface: 'desktop', component: 'AbovePrompt', props: BAND })
    expect(await alt(desktop)).toContain('CONTEXT [38%] 38% 76k/200k')
    setUsage({ ...USAGE, context: { window: 200_000, tokens: 110_002, percent: 55 }, cost: { usd: 3.5 } })
    await step($)
    expect(await alt(desktop)).toContain('CONTEXT [55%] 55% 110k/200k')
    expect(await alt(desktop)).toContain('COST $3.50')
    // Auto-compaction counts the response's output too: 160k less 116k.
    expect(await alt(desktop)).toContain('COMPACT in 44k')
  })

  test('the cache countdown turns over on the minute, not at the next tick', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    world(on)
    answering(on, { input: 2, read: 70_000, written: 5_000, output: 500 })
    await $.session.start({ cwd: '/work/my-repo', surface: 'terminal', isInteractive: true })
    const desktop = await $.ui.mount({ plugin: 'hud', surface: 'desktop', component: 'AbovePrompt', props: BAND })
    await clock.advance(10_000)
    await step($)
    expect(await alt(desktop)).toContain('CACHE ~5m')
    await clock.advance(3 * MIN - 200)
    expect(await alt(desktop)).toContain('CACHE ~3m')
    await clock.advance(400)
    expect(await alt(desktop)).toContain('CACHE ~2m')
  })

  test('the cache tier is read again now and then: overage can drop it to 5m mid-session', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    world(on)
    answering(on, { input: 2, read: 70_000, written: 5_000, output: 500 })
    const entry = (tier: '1h' | '5m') =>
      JSON.stringify({ type: 'assistant', message: { usage: { cache_creation: { [`ephemeral_${tier}_input_tokens`]: 500 } } } })
    let transcript = entry('1h')
    on('fs.stat', () => ({ value: { kind: 'file' as const, size: transcript.length, mtimeMs: NOW, isLink: false } }))
    on('fs.read', () => ({ value: transcript }))
    const stop = () => $.classic.Stop({ session_id: 's', transcript_path: '/t/s.jsonl', cwd: '/work/my-repo', stop_hook_active: false })
    await $.session.start({ cwd: '/work/my-repo', surface: 'terminal', isInteractive: true })
    const desktop = await $.ui.mount({ plugin: 'hud', surface: 'desktop', component: 'AbovePrompt', props: BAND })
    await step($)
    await stop()
    await clock.advance(MIN)
    expect(await alt(desktop)).toContain('CACHE 59m')
    // The tier changed, but a read so soon after the last is not due.
    transcript = entry('5m')
    await stop()
    await clock.advance(100)
    expect(await alt(desktop)).toContain('CACHE 59m')
    await clock.advance(4 * MIN)
    await step($, 1)
    await stop()
    await clock.advance(100)
    expect(await alt(desktop)).toContain('CACHE 5m')
  })
})

