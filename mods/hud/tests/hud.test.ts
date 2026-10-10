import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement, RenderPropsOf, SessionUsage, TurnStepResult } from 'claude-code'

import type { HudPrefs } from '../types'
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
    ])
    expect(panelText(fresh)).toBe('MODEL Opus 5.5 · high\nPROJECT my-repo\nCONTEXT [0%] –/200k')
  })

  test('formats models, tokens and countdowns', () => {
    expect(modelName('claude-fable-5-1')).toBe('Fable 5.1')
    expect(modelName('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5 1M')
    expect([tokens(850), tokens(8_400), tokens(999_600), tokens(1_000_000)]).toEqual(['850', '8.4k', '1M', '1M'])
    expect([span(30_000), span(14 * MIN), span(125 * MIN), span(76 * 60 * MIN)]).toEqual(['<1m', '14m', '2h05m', '3d4h'])
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

/** The machine beneath the plugins: a repo at /work/my-repo, one terminal attached. */
function world(on: On, gitCalls: string[][] = [], commands: string[] = []) {
  mock.store(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('classic.SessionStart', () => ({}))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.run', { command: 'compact' }, ($, e) => {
    commands.push(e.command)
    return { text: 'Compacted.' }
  })
  // The engine's own drawing: an empty band, and the hint line under the prompt.
  on('ui.render', ($, e) =>
    (e.component === 'PromptHint' ? h('Text', { dimColor: true }, e.props.hint) : h('Box', {})) as RenderElement,
  )
  const withBreakdown = { ...USAGE, context: { ...USAGE.context, breakdown: { isAutoCompactEnabled: true, autoCompactThreshold: 160_000 } } }
  on('session.usage', ($, e) => ({ value: (e.breakdown ? withBreakdown : USAGE) as SessionUsage }))
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
}

type Found = { text: string; props: Record<string, unknown> }
type Drawing = { findAll: (q: { type: string }) => Promise<Found[]>; find: (q: { type?: string; key?: string; text?: string | RegExp }) => Promise<Found | undefined> }

/** What a drawing shows: its texts in order, and the readable text of any CRT screen in it. */
async function seen(ui: Drawing): Promise<string> {
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('')
  const screens = (await ui.findAll({ type: 'Svg' })).map(x => `${String(x.props.alt)}\n${String(x.props.source)}`)
  return [texts, ...screens].join('\n')
}

describe('in the engine', () => {
  test('a dark panel on the terminal, a CRT screen on the desktop, and git stays read-only', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const gitCalls: string[][] = []
    world(on, gitCalls)
    await $.session.start({ cwd: '/work/my-repo', surface: 'terminal', isInteractive: true })
    await $.session.measure({ ...USAGE, changed: ['context', 'rateLimits', 'cost'] })
    await clock.advance(100)

    const terminal = await $.ui.mount({ plugin: 'hud', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    const shown = await seen(terminal)
    for (const text of ['▌CLAUDE HUD', 'MODELOpus 5.5 · high', 'PROJECTmy-repo', 'BRANCHfeat/hud ±3', '38% 76k/200k', 'COMPACTin 84k', '42% ↻2h14m', '61% ↻3d4h', 'COST$2.14']) {
      expect(shown).toContain(text)
    }
    expect((await terminal.find({ type: 'Text', text: 'Opus 5.5' }))?.props).toMatchObject({ color: PALETTE.model, bold: true })
    expect((await terminal.find({ key: 'compact' }))?.props.label).toBe(' ▸ compact')
    await terminal.unmount()

    const desktop = await $.ui.mount({ plugin: 'hud', surface: 'desktop', component: 'AbovePrompt', props: BAND })
    const screen = await desktop.find({ type: 'Svg' })
    expect(String(screen?.props.alt)).toContain('CONTEXT [38%] 38% 76k/200k')
    expect(String(screen?.props.source)).toContain('Opus 5.5')
    expect(screen?.props.isInteractive).toBe(true)
    expect((await desktop.find({ key: 'compact' }))?.props.label).toBe('Compact now')

    expect(gitCalls).toEqual([['git', '--no-optional-locks', 'status', '--porcelain=v2', '--branch']])
  })

  test('compact runs /compact on a second press within 5 s', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const commands: string[] = []
    world(on, [], commands)
    await $.session.start({ cwd: '/work/my-repo', surface: 'terminal', isInteractive: true })
    await $.session.measure({ ...USAGE, changed: ['context', 'rateLimits', 'cost'] })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'hud', surface, component: 'AbovePrompt', props: BAND })
      const before = commands.length
      await ui.press({ key: 'compact' })
      expect(commands).toHaveLength(before)
      expect((await ui.find({ key: 'compact' }))?.props.label).toBe(surface === 'desktop' ? 'Confirm compact' : ' ▸ confirm?')
      await clock.advance(5_200)
      expect((await ui.find({ key: 'compact' }))?.props.label).toBe(surface === 'desktop' ? 'Compact now' : ' ▸ compact')
      await ui.press({ key: 'compact' })
      await ui.press({ key: 'compact' })
      await ui.unmount()
    }
    expect(commands).toEqual(['compact', 'compact'])
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
})

