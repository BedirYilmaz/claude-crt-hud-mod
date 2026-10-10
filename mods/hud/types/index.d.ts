// The hud mod's state contract: every value it keeps in `$.state`.

/** Where the rows sit: a band above the prompt, or under it beside the hint line. */
export type HudPosition = 'above' | 'below'

/** What `/hud` sets; mirrored to `$.store` so it holds across sessions. */
export type HudPrefs = {
  isVisible: boolean
  position: HudPosition
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

/** Alert thresholds already toasted, per gauge (`context`, `five_hour`, ...). */
export type HudFired = Record<string, number[]>

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
    }
  }
}
