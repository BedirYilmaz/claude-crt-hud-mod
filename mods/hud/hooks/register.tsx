// hud: a CRT-style panel above or below the prompt. Every `$` call is in this
// file; panel.ts says what the panel holds, crt.ts draws it for the desktop,
// alerts.ts says when to toast, and parse.ts
// reads git, the transcript and `/hud`. It only reads: git as
// `git --no-optional-locks status`, the transcript once a session for the
// cache tier. It writes `$.state` and its own `$.store`, and makes no model
// call and no network request.
import { atom, read, update } from 'claude-code'
import type { Elements, Register, RenderElement, SessionContextUsage, SessionCost, SessionRateLimit, Timer } from 'claude-code'

import type { HudCache, HudCompactRun, HudHitMessage, HudHitProps, HudPrefs, HudRepo, HudUsage } from '../types'
import { alertsFor } from './alerts.js'
import {
  type HudProbe,
  baseName,
  describePointer,
  describeProbe,
  lastCacheTtl,
  parseGitStatus,
  prefsFrom,
  runHudCommand,
} from './parse.js'
import { crtScreen } from './crt.js'
import { type Line, PALETTE, TTL_MS, buildPanel, fitPanel, panelText, toolName } from './panel.js'

const DEFAULT_PREFS: HudPrefs = { isVisible: true, position: 'above', alerts: { context: [], usage: [] } }
const EMPTY_USAGE: HudUsage = { tokens: null, window: 0, percent: null, usd: null, limits: [] }
const FRESH_CACHE: HudCache = { lastRequestAt: null, ttl: '5m', isTtlKnown: false, tokens: null }

const project = atom({ plugin: 'hud', key: 'project' } as const, null)
const prefs = atom({ plugin: 'hud', key: 'prefs' } as const, DEFAULT_PREFS)
const repo = atom({ plugin: 'hud', key: 'repo' } as const, null)
const usage = atom({ plugin: 'hud', key: 'usage' } as const, EMPTY_USAGE)
const model = atom({ plugin: 'hud', key: 'model' } as const, { id: '', effort: null })
const compact = atom({ plugin: 'hud', key: 'compact' } as const, null)
const cache = atom({ plugin: 'hud', key: 'cache' } as const, FRESH_CACHE)
const activity = atom({ plugin: 'hud', key: 'activity' } as const, { tools: {}, agents: 0 })
const tick = atom({ plugin: 'hud', key: 'tick' } as const, 0)
const fired = atom({ plugin: 'hud', key: 'fired' } as const, {})
const compactArm = atom({ plugin: 'hud', key: 'compactArm' } as const, null)
const compactRun = atom({ plugin: 'hud', key: 'compactRun' } as const, null)
const isHidden = atom({ plugin: 'hud', key: 'isHidden' } as const, false)

const STORE_PREFS = 'prefs'
const STORE_TTL = 'ttl'
/** What the click layer has reported (`/hud debug`), kept while the in-screen controls are on trial. */
const STORE_DEBUG = 'debug'

/** git runs at most this often; changes inside the gap are picked up at its end. */
const GIT_GAP_MS = 5_000
/** How often countdowns redraw: they show whole minutes. */
const TICK_MS = 30_000
/** A transcript past this is not read for the cache tier; the stored guess stands. */
const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024
/** Turn ends that look for a cache write before giving up for the session. */
const MAX_TTL_SCANS = 3

/** Tools after which the working tree may differ. */
const MUTATING = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'])
/** Agent calls are counted as agents, not drawn as a running tool. */
const AGENT_TOOLS = new Set(['Agent', 'Task'])
const LIVE_AGENT = new Set(['pending', 'running', 'waiting'])

/** A first press on compact arms it; a second within this long runs /compact. */
const ARM_MS = 5_000
/** A second press sooner than this is a double-click, not a confirmation. */
const SAME_CLICK_MS = 400
/** Pointer events and faults kept for `/hud debug`. */
const PROBE_LOG = 12
/**
 * Rows the click layer covers: the CRT's header, where its controls are. The
 * desktop sizes the region to what hit.tsx draws, so it draws this many; one
 * row reached only the top of the controls.
 */
const HIT_ROWS = 2
/** The terminal panel's narrowest, and its label column. */
const MIN_COLUMNS = 32
const LABEL_COLUMNS = 9
/**
 * A desktop cell (its code font's advance) in CSS pixels, a little over, so the
 * screen comes out at least as wide as the band: the desktop scales a wider
 * one down to the slot, and the engine's five reserved columns are added back.
 */
const DESKTOP_CELL_PX = 8
const ENGINE_COLUMNS = 5
const MIN_SCREEN_PX = 380
/** Lines drawn where the site gives no height. */
const DEFAULT_LINES = 12

type TerminalUi = Pick<Elements['terminal'], 'Box' | 'Text'>

/** What the background work needs, as closures over session.start's `$`. */
type Host = {
  now: () => Promise<number>
  after: (ms: number, fn: () => void) => Timer
  isDrawn: () => Promise<boolean>
  isVisible: () => Promise<boolean>
  bump: () => Promise<void>
  cwd: () => Promise<string>
  repoRoot: () => Promise<string | null>
  status: (cwd: string) => Promise<string | null>
  setRepo: (value: HudRepo) => Promise<void>
  setProject: (name: string) => Promise<void>
  /** A press on compact: arms it, or runs /compact when armed. */
  pressCompact: () => Promise<void>
  /** A press on hide: hidden for this session. */
  hide: () => Promise<void>
}

function usageOf(u: { context: SessionContextUsage; rateLimits: readonly SessionRateLimit[]; cost?: SessionCost }): HudUsage {
  return {
    tokens: u.context.tokens ?? null,
    window: u.context.window,
    percent: u.context.percent ?? null,
    usd: u.cost?.usd ?? null,
    limits: u.rateLimits.map(r => {
      const resetsAt = r.resetsAt ? Date.parse(r.resetsAt) : Number.NaN
      return { kind: r.kind, percent: r.percentUsed, resetsAt: Number.isNaN(resetsAt) ? null : resetsAt }
    }),
  }
}

const liveAgents = (agents: readonly { status: string }[]) => agents.filter(a => LIVE_AGENT.has(a.status)).length

const chars = (text: string) => [...text].length

/**
 * The panel on the terminal: a dark box, labels left, values flush right, gauges
 * aligned between them, every other line a shade lighter like a scanline.
 */
function drawPanel(
  ui: TerminalUi,
  lines: readonly Line[],
  o: { columns: number; isWorking: boolean; run: HudCompactRun; indent: number; compact: RenderElement; hide: RenderElement },
): RenderElement {
  const { Box, Text } = ui
  const width = Math.max(MIN_COLUMNS, o.columns - o.indent)
  const inner = width - 4
  const valueColumns = Math.max(0, ...lines.filter(l => l.gauge).map(l => chars(l.value.map(x => x.text).join(''))))
  const gaugeColumns = inner - LABEL_COLUMNS - 1 - valueColumns
  return (
    <Box flexDirection="column" width={width} marginLeft={o.indent} borderStyle="round" borderColor={PALETTE.edge} backgroundColor={PALETTE.bg} paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text color={PALETTE.label} bold>
          ▌CLAUDE HUD
        </Text>
        <Box flexDirection="row" columnGap={2}>
          <Text color={o.run !== null || o.isWorking ? PALETTE.warn : PALETTE.dim}>
            {o.run === 'running' ? '◌ COMPACTING' : o.run === 'queued' ? '◌ COMPACT QUEUED' : o.isWorking ? '● WORKING' : '○ IDLE'}
          </Text>
          {o.hide}
        </Box>
      </Box>
      {lines.map((line, i) => {
        const filled = line.gauge ? Math.min(gaugeColumns, Math.max(0, Math.round((line.gauge.percent / 100) * gaugeColumns))) : 0
        return (
          <Box key={`row-${line.key}`} flexDirection="row" backgroundColor={i % 2 ? PALETTE.scan : PALETTE.bg}>
            <Box width={LABEL_COLUMNS} flexShrink={0}>
              {line.action === 'compact' ? o.compact : <Text color={PALETTE.label}>{line.label}</Text>}
            </Box>
            {line.gauge && gaugeColumns >= 6 ? (
              <Box width={gaugeColumns} flexShrink={0}>
                <Text color={PALETTE[line.gauge.tone]}>{'█'.repeat(filled)}</Text>
                <Text color={PALETTE.track}>{'░'.repeat(gaugeColumns - filled)}</Text>
              </Box>
            ) : null}
            <Box flexGrow={1} flexDirection="row" justifyContent="flex-end">
              {line.value.map((x, k) => (
                <Text key={`${k}`} color={PALETTE[x.tone]} {...(x.bold ? { bold: true } : {})}>
                  {x.text}
                </Text>
              ))}
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

export const register: Register = on => {
  let host: Host | undefined
  let ticker: Timer | undefined
  let expiry: Timer | undefined
  const git = { isRunning: false, isQueued: false, lastAt: 0, timer: undefined as Timer | undefined }
  let projectName: { cwd: string; name: string } | undefined
  let ttlScans = 0
  // What the click layer over the desktop's screen reported, and whether the engine said it failed.
  const probe: HudProbe = { screen: null, layer: null, events: [], faults: [] }
  let isLayerBroken = false
  /** The layer's press count acted on; null until its first post, which only sets it. */
  let seenPresses: number | null = null

  /** One git pass: the branch and dirty count, and the project's name, rewritten each time. */
  async function gitPass(h: Host): Promise<void> {
    // Nothing draws under `claude -p`: no git there. Nor while the HUD is off.
    if (!(await h.isDrawn()) || !(await h.isVisible())) return
    git.isRunning = true
    try {
      const cwd = await h.cwd()
      const stdout = await h.status(cwd)
      await h.setRepo(stdout === null ? null : parseGitStatus(stdout))
      if (projectName?.cwd !== cwd) projectName = { cwd, name: baseName((await h.repoRoot()) ?? cwd) }
      // Written at every pass, so a mask switched on mid-session applies at the next one.
      await h.setProject(projectName.name)
    } finally {
      git.isRunning = false
      git.lastAt = await h.now()
      if (git.isQueued) {
        git.isQueued = false
        void scheduleGit()
      }
    }
  }

  /** Runs git once the gap since the last run has passed; requests in between fold into that run. */
  async function scheduleGit(): Promise<void> {
    const h = host
    if (!h || git.timer) return
    if (git.isRunning) {
      git.isQueued = true
      return
    }
    const wait = Math.max(50, git.lastAt + GIT_GAP_MS - (await h.now()))
    git.timer = h.after(wait, () => {
      git.timer = undefined
      void gitPass(h).catch(() => {})
    })
  }

  /** Redraws the countdown the moment the cache expires, not at the next tick. */
  async function armExpiry(c: HudCache): Promise<void> {
    expiry?.cancel()
    expiry = undefined
    const h = host
    if (!h || c.lastRequestAt === null) return
    const left = c.lastRequestAt + TTL_MS[c.ttl] - (await h.now())
    if (left > 0) expiry = h.after(left + 1_000, () => void h.bump().catch(() => {}))
  }

  on('session.start', async ($, e, next) => {
    host = {
      now: () => $.clock.now(),
      after: (ms, fn) => $.clock.after(ms, fn),
      isDrawn: async () => (await $.session.surfaces().catch(() => [])).length > 0,
      isVisible: async () => (await read($, prefs)).isVisible,
      bump: async () => {
        if (!(await read($, prefs)).isVisible) return
        const now = await $.clock.now()
        await update($, tick, () => now)
      },
      cwd: () => $.session.cwd(),
      repoRoot: () => $.session.repo().then(r => r?.root ?? null, () => null),
      status: async cwd => {
        const ran = await $.process
          .run(['git', '--no-optional-locks', 'status', '--porcelain=v2', '--branch'], { cwd, timeoutMs: 5_000 })
          .catch(() => null)
        return ran?.exitCode === 0 ? ran.stdout : null
      },
      setRepo: async value => void (await update($, repo, () => value)),
      setProject: async name => void (await update($, project, () => name)),
      pressCompact: async () => {
        const at = await $.clock.now()
        // One compaction at a time: a press while one is queued or running would queue another.
        const run = await read($, compactRun)
        if (run !== null) {
          await update($, compactArm, () => null)
          $.ui.toast(run === 'running' ? 'Already compacting.' : '/compact is queued: it runs when Claude is idle.')
          return
        }
        const was = await read($, compactArm)
        if (was !== null && at - was < SAME_CLICK_MS) return
        if (was !== null && at - was < ARM_MS) {
          await update($, compactArm, () => null)
          await update($, compactRun, () => 'queued')
          // As if typed: it shows in the transcript and waits until the session is idle; it resolves once it ran.
          void $.command
            .run({ command: 'compact', args: '' })
            .catch(() => {})
            .finally(() => void update($, compactRun, () => null).catch(() => {}))
        } else {
          await update($, compactArm, () => at)
          $.clock.after(ARM_MS + 100, () => void host?.bump().catch(() => {}))
        }
      },
      hide: async () => {
        await update($, isHidden, () => true)
        $.ui.toast('HUD hidden for this session. /hud shows it again.')
      },
    }
    // A reload leaves the session's state: a run it was waiting on is no one's now.
    await update($, compactRun, () => null)
    await $.command.register({
      name: 'hud',
      description: 'Turn the HUD on or off; also above, below, alerts',
      argumentHint: '[on|off|above|below|alerts …]',
      immediate: true,
    })
    const storedPrefs = await $.store.get(STORE_PREFS)
    await update($, prefs, () => prefsFrom(storedPrefs, DEFAULT_PREFS))
    // The tier the last session found: a guess (`~` on the countdown) until this one confirms it.
    const storedTtl = await $.store.get(STORE_TTL)
    const guess: HudCache['ttl'] | null = storedTtl === '1h' || storedTtl === '5m' ? storedTtl : null
    await update($, cache, c => (c.isTtlKnown || guess === null ? c : { ...c, ttl: guess }))

    const [measured, id, settings] = await Promise.all([
      $.session.usage().catch(() => null),
      $.session.model().catch(() => ''),
      $.settings.read().catch(() => ({}) as Record<string, unknown>),
    ])
    if (measured) await update($, usage, () => usageOf(measured))
    // Where auto-compaction runs, so a reload shows it before the next measurement.
    const window = measured?.context.window ?? 0
    if (window > 0 && (await read($, compact))?.window !== window) {
      void $.session
        .usage({ breakdown: 'summary' })
        .then(async u => {
          const b = u.context.breakdown
          if (b) await update($, compact, () => ({ window, at: b.isAutoCompactEnabled ? (b.autoCompactThreshold ?? null) : null }))
        })
        .catch(() => {})
    }
    const effortLevel = (settings as { effortLevel?: unknown }).effortLevel
    await update($, model, m => ({ id: id || m.id, effort: m.effort ?? (typeof effortLevel === 'string' ? effortLevel : null) }))
    await update($, project, name => name ?? baseName(e.cwd))

    ticker?.cancel()
    ticker = $.clock.every(TICK_MS, () => void host?.bump().catch(() => {}))
    await armExpiry(await read($, cache))
    void scheduleGit()
    return next(e)
  })

  // The engine pushes the status-line figures as they move.
  on('session.measure', async ($, e, next) => {
    const u = usageOf(e)
    await update($, usage, () => u)
    // Where auto-compaction runs: read again only when the window changes (a local estimate, no request).
    if (e.changed.includes('context') && u.window > 0 && (await read($, compact))?.window !== u.window) {
      const breakdown = await $.session.usage({ breakdown: 'summary' }).then(x => x.context.breakdown, () => undefined)
      if (breakdown) {
        const at = breakdown.isAutoCompactEnabled ? (breakdown.autoCompactThreshold ?? null) : null
        await update($, compact, () => ({ window: u.window, at }))
      }
    }
    const { alerts } = await read($, prefs)
    if (alerts.context.length || alerts.usage.length) {
      const was = await read($, fired)
      const result = alertsFor(alerts, was, u, await $.clock.now())
      if (JSON.stringify(result.fired) !== JSON.stringify(was)) await update($, fired, () => result.fired)
      if (result.message) $.ui.toast(result.message)
    }
    return next(e)
  })

  // Each main-thread request restarts the prompt cache's clock.
  on('turn.step', async function* ($, e, next) {
    const startedAt = await $.clock.now()
    // No event says the model or effort changed: the first request after a switch is the
    // earliest the HUD can know, so it shows them as that request goes out. Its own effort,
    // or none: an earlier level would outlive a switch to a default.
    if (e.agentId === undefined) {
      const effort = e.effort === undefined ? null : String(e.effort)
      await update($, model, () => ({ id: e.model, effort }))
    }
    const result = yield* next(e)
    if (e.agentId === undefined) {
      const used = result.usage
      if (used) {
        const sent = used.input_tokens + used.cache_read_input_tokens + used.cache_creation_input_tokens + used.output_tokens
        await update($, cache, c => ({ ...c, lastRequestAt: startedAt, tokens: sent }))
        await armExpiry(await read($, cache))
      }
    }
    return result
  })

  on('tool.call', async ($, e, next) => {
    const name = String(e.tool)
    const id = e.tool_use_id
    const isAgent = AGENT_TOOLS.has(name)
    if (!isAgent) await update($, activity, a => ({ ...a, tools: { ...a.tools, [id]: toolName(name) } }))
    try {
      return await next(e)
    } finally {
      if (isAgent) {
        const agents = liveAgents(await $.agent.list().catch(() => []))
        await update($, activity, a => ({ ...a, agents }))
      } else {
        await update($, activity, a => ({ ...a, tools: Object.fromEntries(Object.entries(a.tools).filter(([key]) => key !== id)) }))
      }
      if (MUTATING.has(name)) void scheduleGit()
    }
  }).catch(($, e, next) => next(e))

  // Picks up what changed outside the session between turns.
  on('turn.start', async ($, e, next) => {
    void scheduleGit()
    return next(e)
  })

  // A subagent's run ends in its own turn.complete: the count drops then.
  on('turn.complete', async ($, e, next) => {
    const agents = liveAgents(await $.agent.list().catch(() => []))
    await update($, activity, a => (a.agents === agents ? a : { ...a, agents }))
    return next(e)
  })

  // A compaction of the conversation runs: the HUD says so and compact presses wait.
  // One that stands starts a new cache: nothing to count down until the next request.
  // `precompute` summarizes ahead of time in the background, and changes neither.
  on('session.compact', async ($, e, next) => {
    const isMain = e.agentId === undefined && e.trigger !== 'precompute'
    if (isMain) await update($, compactRun, () => 'running')
    try {
      const result = await next(e)
      if (isMain) {
        await update($, cache, c => ({ ...c, lastRequestAt: null, tokens: null }))
        await armExpiry(await read($, cache))
      }
      return result
    } finally {
      if (isMain) await update($, compactRun, () => null).catch(() => {})
    }
  }).catch(($, e, next) => next(e))

  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear') {
      await update($, cache, c => ({ ...c, lastRequestAt: null, tokens: null }))
      await update($, fired, () => ({}))
    }
    const seconds = e.seconds_since_last_response
    if ((e.source === 'resume' || e.source === 'fork') && seconds !== undefined) {
      // The engine says how long ago the resumed session last answered and whether that outlived the cache.
      const now = await $.clock.now()
      const expired = e.prompt_cache_likely_expired
      await update($, cache, c => {
        const ttl: HudCache['ttl'] | null =
          c.isTtlKnown || expired === undefined ? null : !expired && seconds > 300 ? '1h' : expired && seconds <= 3600 ? '5m' : null
        return { ...c, lastRequestAt: now - seconds * 1000, tokens: e.context_tokens ?? c.tokens, ...(ttl ? { ttl, isTtlKnown: true } : {}) }
      })
    }
    await armExpiry(await read($, cache))
    return next(e)
  }).catch(($, e, next) => next(e))

  // The cache tier is in the transcript only: read it at a turn's end, until found.
  on('classic.Stop', async ($, e, next) => {
    if (ttlScans < MAX_TTL_SCANS && !(await read($, cache)).isTtlKnown && e.transcript_path) {
      ttlScans += 1
      const stat = await $.fs.stat(e.transcript_path).catch(() => null)
      const text = stat?.kind === 'file' && stat.size <= MAX_TRANSCRIPT_BYTES ? await $.fs.read(e.transcript_path).catch(() => '') : ''
      const ttl = lastCacheTtl(text)
      if (ttl) {
        ttlScans = MAX_TTL_SCANS
        await update($, cache, c => ({ ...c, ttl, isTtlKnown: true }))
        await $.store.set(STORE_TTL, ttl)
        await armExpiry(await read($, cache))
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // A switch forfeits the cache: the next request writes the whole context again.
  on('classic.PostModelSwitch', async ($, e, next) => {
    await update($, model, m => ({ ...m, id: e.to_model }))
    await update($, cache, c => ({
      ...c,
      ttl: e.cache_ttl,
      isTtlKnown: true,
      lastRequestAt: c.lastRequestAt === null ? null : 0,
      tokens: e.context_tokens || c.tokens,
    }))
    await armExpiry(await read($, cache))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'hud' }, async ($, e) => {
    const was = await read($, prefs)
    // Hidden by its hide control: `/hud`, `on`, `above` or `below` bring it back.
    const verb = e.args.trim().toLowerCase()
    if (verb === 'debug') return { text: describeProbe(probe).join('\n') }
    const isShowing = (await read($, isHidden)) && ['', 'on', 'above', 'below'].includes(verb)
    if (isShowing) await update($, isHidden, () => false)
    const { prefs: now, text } = runHudCommand(isShowing && verb === '' ? 'on' : e.args, was)
    if (JSON.stringify(now) !== JSON.stringify(was)) {
      await update($, prefs, () => now)
      await $.store.set(STORE_PREFS, now)
      if (JSON.stringify(now.alerts) !== JSON.stringify(was.alerts)) await update($, fired, () => ({}))
      if (now.isVisible && !was.isVisible) {
        void scheduleGit()
        const at = await $.clock.now()
        await update($, tick, () => at)
      }
    }
    return { text }
  })

  // The click layer over the desktop's screen: its size, the pointer's events, and its presses.
  on('ui.message', async ($, e, next) => {
    if (e.element === 'hit') {
      const m = (e.data ?? {}) as Partial<HudHitMessage>
      const layer = { columns: Number(m.columns ?? 0), rows: Number(m.rows ?? 0), moves: Number(m.moves ?? 0), presses: Number(m.presses ?? 0) }
      probe.layer = layer
      if (m.pointer) probe.events = [...probe.events, describePointer(m.pointer, layer, m.press)].slice(-PROBE_LOG)
      // The surface keeps one post per frame: a press is a rise in the count, whichever post carries it.
      const isPress = seenPresses !== null && layer.presses > seenPresses
      seenPresses = layer.presses
      await $.store.set(STORE_DEBUG, describeProbe(probe)).catch(() => {})
      if (isPress && m.pressed === 'compact') await host?.pressCompact()
      if (isPress && m.pressed === 'hide') await host?.hide()
    }
    return next(e)
  })

  // The click layer failed on a surface: leave it out from now on (the native buttons stay), and say why.
  on('ui.fault', async ($, e, next) => {
    if (e.element === 'hit') {
      isLayerBroken = true
      probe.faults = [...probe.faults, `${e.surface} ${e.phase}: ${e.reason}`].slice(-PROBE_LOG)
      $.ui.log(`hud: the click layer over the CRT screen failed (${e.phase}): ${e.reason}`)
      await $.store.set(STORE_DEBUG, describeProbe(probe)).catch(() => {})
    }
    return next(e)
  })

  // Above the prompt as a band, or under it before the engine's hint line.
  on('ui.render', { component: ['AbovePrompt', 'PromptHint'] }, async ($, e, next) => {
    const p = await read($, prefs)
    const isAbove = e.component === 'AbovePrompt'
    if (!p.isVisible || p.position !== (isAbove ? 'above' : 'below') || (await read($, isHidden))) return next(e)
    if (e.component === 'AbovePrompt' && e.props.hasSurvey) return next(e)
    const width = e.component === 'AbovePrompt' ? e.props.bodyColumns : e.viewport?.columns
    await read($, tick)
    const now = await $.clock.now()
    const all = buildPanel({
      project: await read($, project),
      repo: await read($, repo),
      usage: await read($, usage),
      model: await read($, model),
      compact: await read($, compact),
      compactRun: await read($, compactRun),
      cache: await read($, cache),
      activity: await read($, activity),
      now,
    })
    const rest = await next(e)
    if (all.length === 0) return rest

    // Compact runs on a second press within ARM_MS: /compact cannot be undone.
    const run = await read($, compactRun)
    const armedAt = await read($, compactArm)
    const isArmed = run === null && armedAt !== null && now - armedAt < ARM_MS
    const isWorking = e.props.isWorking

    if (e.surface === 'desktop') {
      const { Box, Button, Client, Svg } = $.ui.resolve(e)
      const columns = (width ?? 100) + (isAbove ? ENGINE_COLUMNS : 0)
      const screen = crtScreen(all, { width: Math.max(MIN_SCREEN_PX, columns * DESKTOP_CELL_PX), isWorking, isArmed, compactRun: run })
      const hit: HudHitProps = { width: screen.width, rows: HIT_ROWS, targets: screen.targets }
      probe.screen = hit
      // An image with no size of its own: the desktop draws it as wide as the band, its height in proportion.
      // An image takes no presses: a transparent click layer over its header hits the controls drawn there.
      // On trial: the native buttons under it stay until the layer is known to work on the desktop.
      return (
        <Box flexDirection="column">
          <Box position="relative" flexDirection="column">
            <Svg key="screen" source={screen.source} alt={panelText(all)} />
            {isLayerBroken ? null : (
              <Box position="absolute" top={0} left={0} width="100%" height={HIT_ROWS}>
                <Client key="hit" module="./hit.tsx" props={hit} width="100%" height={HIT_ROWS} />
              </Box>
            )}
          </Box>
          <Box flexDirection="row" justifyContent="flex-end" columnGap={1}>
            <Button
              key="compact"
              variant={isArmed ? 'primary' : 'secondary'}
              label={run === 'running' ? 'Compacting…' : run === 'queued' ? 'Compact queued' : isArmed ? 'Click again to compact' : 'Compact'}
              onPress={() => host?.pressCompact()}
            />
            <Button key="hide" role="dismiss" label="Hide HUD" onPress={() => host?.hide()} />
          </Box>
          {rest}
        </Box>
      )
    }

    const indent = isAbove ? 2 : 0
    const { Box, Button, Text } = $.ui.resolve(e)
    const room = e.component === 'AbovePrompt' ? e.props.maxRows - 3 : DEFAULT_LINES
    const lines = fitPanel(all, Math.max(4, room))
    const compactButton =
      run === null ? (
        <Button key="compact" plain label={isArmed ? 'CONFIRM ▸' : 'COMPACT ▸'} onPress={() => host?.pressCompact()} />
      ) : (
        <Text color={PALETTE.dim}>COMPACT ◌</Text>
      )
    const hideButton = <Button key="hide" plain label="✕" onPress={() => host?.hide()} />
    return (
      <Box flexDirection="column">
        {drawPanel({ Box, Text }, lines, { columns: width ?? 80, isWorking, run, indent, compact: compactButton, hide: hideButton })}
        {rest}
      </Box>
    )
  })
}
