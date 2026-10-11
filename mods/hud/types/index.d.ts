// The hud mod's state contract: every value it keeps in `$.state`.

/** Where the rows sit: a band above the prompt, or under it beside the hint line. */
export type HudPosition = 'above' | 'below'

/** What `/hud` sets; mirrored to `$.store` so it holds across sessions. */
export type HudPrefs = {
  isVisible: boolean
  position: HudPosition
  /** Only the context and the plan windows, the cost in the header: `▾ MIN` and `▴ MAX` switch it. */
  isMinimal: boolean
  /** Toast thresholds in percent; empty lists are off. */
  alerts: { context: number[]; usage: number[] }
}

/** `git status` of the session's working directory; null outside a repository. */
export type HudRepo = {
  /** The branch, `@<sha7>` when detached, null on an unborn branch. */
  branch: string | null
  /** Changed, staged and untracked paths. */
  dirty: number
} | null

/** One plan window (`five_hour`, `seven_day`, a gateway's `spend_limit`). */
export type HudLimit = { kind: string; percent: number; resetsAt: number | null }

/** The status-line figures, as `$.session.usage()` and `session.measure` report them. */
export type HudUsage = {
  /** Input tokens of the last response; null before one came back. */
  tokens: number | null
  window: number
  percent: number | null
  usd: number | null
  limits: HudLimit[]
}

export type HudModel = { id: string; effort: string | null }

/** Where auto-compaction runs (null: off), for the window it was read for. */
export type HudCompact = { window: number; at: number | null } | null

/** The main thread's prompt cache: its clock and what a cold start re-writes. */
export type HudCache = {
  /** When the last main-thread request started (ms); null before one. */
  lastRequestAt: number | null
  ttl: '5m' | '1h'
  /** False while the TTL is a guess (no cache write read yet this session). */
  isTtlKnown: boolean
  /** Prompt tokens the next request sends again: input + cache + output. */
  tokens: number | null
}

/** Tools running now by tool_use_id, and the subagents in flight. */
export type HudActivity = { tools: Record<string, string>; agents: number }

/** A /compact the HUD asked for, waiting for the session to go idle, or any compaction of the conversation running now. */
export type HudCompactRun = 'queued' | 'running' | null

/** Alert thresholds already toasted, per gauge (`context`, `five_hour`, ...). */
export type HudFired = Record<string, number[]>

/** A control in the CRT screen's header: where it spans across, in the SVG markup's pixels. */
export type HudHitTarget = { key: string; left: number; right: number }

/** What the click layer over the header (hooks/hit.tsx) is handed: the markup's width, the rows it covers, and the controls. */
export type HudHitProps = { width: number; rows: number; targets: HudHitTarget[] }

/** One pointer event as the surface reported it to the click layer, and the control under it. */
export type HudHitPointer = {
  type: string
  x: number
  y: number
  fine: { x: number; y: number } | null
  button: string | null
  target: string | null
}

/**
 * What the click layer posts: its region in cells and the moves it has seen,
 * with the pointer event (and the press, when it hit a control) if there was one.
 * Every post also carries how many presses the layer has made and the last
 * one's control: the surface keeps one post per frame, so a press whose post
 * the up after it replaced still arrives.
 */
export type HudHitMessage = {
  columns: number
  rows: number
  moves: number
  presses: number
  pressed: string | null
  pointer?: HudHitPointer
  press?: string
}

declare module 'claude-code' {
  interface PluginState {
    hud: {
      /**
       * The project's name as the rows show it: the one place the HUD keeps it.
       * Written at session start and at every git refresh. A screen-mask mod
       * hooks `state.set` on `{ plugin: 'hud', key: 'project' }` and passes
       * `next` another value; nothing else in the HUD names the project.
       */
      project: string | null
      prefs: HudPrefs
      repo: HudRepo
      usage: HudUsage
      model: HudModel
      compact: HudCompact
      cache: HudCache
      activity: HudActivity
      /** Bumped on a timer so countdowns redraw; the time it was bumped (ms). */
      tick: number
      fired: HudFired
      /** When compact was pressed once (ms); a second press within 5 s runs /compact. */
      compactArm: number | null
      /** A /compact queued by the HUD, or a compaction running: compact presses wait for it. */
      compactRun: HudCompactRun
      /** Hidden by its hide control for this session; `/hud` shows it again. */
      isHidden: boolean
    }
  }
}
