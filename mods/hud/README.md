# hud

A CRT-style status panel for Claude Code, in the terminal and in the desktop app's Code tab. It is
inspired by [hoobnn's hud](https://github.com/hoobnn/hoobnn-agent-mods/tree/main/claude-code/hud), a
port of [claude-hud](https://github.com/jarrodwatts/claude-hud). This is a separate, much smaller mod
(about 60 KB of source in six files) with no Node shims.

```
▌CLAUDE HUD█               ● WORKING  [COMPACT ▸]  [✕ HIDE]
MODEL                                      Opus 5.5 1M · xhigh
PROJECT                                                my-repo
BRANCH                                                 main ±3
CONTEXT   ▮▮▮▮▮▮▮▮▮▮▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯   37% 372k/1M
COMPACT                                                in 594k
5-HOUR    ▮▮▮▮▮▮▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯     16% ↻52m
7-DAY     ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯▯    44% ↻2d9h
CACHE                                                      57m
COST                                                    $10.17
RUNNING                                         Bash · 1 agent
```

One line per part: the label on the left, the value flush right, and the gauges in one column
between them. The panel takes the full width of the band (or of the prompt, below it).

- **Desktop:** an SVG screen. It has a dark glass, phosphor glow, scanlines, a vignette, a slow
  rolling scan band, a subtle flicker and a blinking cursor. All of the motion stops when the system
  asks for reduced motion. It is drawn as an image with no size of its own: the markup is laid out a
  little wider than the band (8 px a cell, plus the engine's five reserved cells) and the desktop
  scales it down to fit, its height in proportion. An image takes no clicks, so a transparent click
  layer (`hooks/hit.tsx`, a `Client`) lies over the screen's header, where `COMPACT ▸` and `✕ HIDE`
  are drawn. The desktop reports exactly where across that layer a click lands, but its rows don't
  map onto the image's pixels, so both controls share the header row and only the column decides
  which one was clicked. The desktop sizes the layer to what it draws rather than to its height, so
  it draws two empty rows to cover the whole header. It keeps one post per frame from the layer, so
  every post carries a running count of presses: a quick click still counts when the post of its
  up replaced the post of its down. If the engine reports that the layer failed, the HUD leaves
  it out, draws native `Compact` and `Hide HUD` buttons under the screen instead, and says why in
  the transcript. Nothing on the screen changes on hover.
- **Terminal:** a dark, round-bordered box. Every other line is a shade lighter, like a scanline.
  The gauges are `█░`. `COMPACT ▸` and `✕` are buttons: click them, or reach them with ctrl+x tab.

The header shows `● WORKING` (blinking amber) while a turn runs, `◌ COMPACTING` or
`◌ COMPACT QUEUED` while a compaction runs or waits, and `○ IDLE` otherwise.

### Compact and hide

- **Compact:** `COMPACT ▸` in the desktop screen's header, or the `COMPACT ▸` label on the
  terminal. A first press arms it for 5 seconds: the COMPACT line turns
  amber and reads `click again to compact`, and the control turns amber (`CONFIRM ▸` on the
  terminal). A second press in that
  time runs `/compact`, exactly as if you had typed it: it shows in the transcript and waits until
  the session is idle. The two presses guard against a stray click, since a compaction cannot be
  undone; a double-click (two presses within 0.4 s) counts as one.
- **One compaction at a time:** from the confirming press until the compaction ends, and during
  any other compaction of the conversation (a typed `/compact`, auto-compaction), the compact
  control rests dim and the COMPACT line reads `queued · runs when idle` or `compacting…`. A press
  then only says so in a toast: it queues no second `/compact`. A summary computed ahead of time in
  the background (`precompute`) changes nothing on screen.
- **While compacting:** Claude Code holds every slash command, `/hud` too, until the compaction
  ends. `✕ HIDE` still reaches the HUD then, since it is not a command.
- **Hide:** `✕ HIDE` in the header (desktop) or `✕` (terminal) puts the panel away for this session. `/hud`
  brings it back. A new session shows it again; `/hud off` hides it for good.

### Colors

The panel keeps its own dark glass whatever your theme, so its colors are fixed. They are all set in
one place, `PALETTE` in `hooks/panel.ts`:

| What | Color |
| --- | --- |
| Labels | phosphor green |
| Model and effort | amber |
| Project | cyan |
| Branch | green when clean, yellow with uncommitted changes |
| Gauges | green, then amber and red: context from 70% and 85%, a plan window from 80% and 95% |
| Cache countdown | teal; amber once expired, if the rebuild costs 20k tokens or more |
| Cost | violet |
| Running tools and agents | periwinkle |

## What it shows

| Line | Source |
| --- | --- |
| `MODEL` | The last main-thread request (`turn.step`) as it goes out, with its own effort (none shown when it sends none). No event reports a switch, so one made while Claude is idle shows with the next request. Before the first request, `$.session.model()` and `effortLevel` from settings. |
| `PROJECT`, `BRANCH` with `±` uncommitted paths | The project is the repository root's name (the main tree's name for a worktree), else the directory's. The branch and count come from `git --no-optional-locks status --porcelain=v2 --branch`. |
| `CONTEXT` | `$.session.usage()` and the `session.measure` pushes. |
| `COMPACT` | The tokens left before auto-compaction (`in 594k`). The engine's own threshold comes from `usage({ breakdown: 'summary' })`, a local estimate that sends no request, read at load and again only when the window changes. Right after a compaction, before the context is measured again, it shows the threshold (`at 920k`); with auto-compaction off, `auto off`. The line always shows, since it carries the compact control. |
| `5-HOUR`, `7-DAY` with the reset countdown | `usage().rateLimits`; absent off a subscription. |
| `CACHE` | Derived (see below). |
| `COST` | `usage().cost`, as `/cost` totals it. |
| `RUNNING` | The tools running now (`tool.call`), and `$.agent.list()` entries that are pending, running or waiting. Shown only while something runs. |

When the terminal band has too few rows, lines drop in this order: running, cost, 7-day, branch,
cache, compact. A line that warns drops after every calm one. The model, the project, the context
and the first plan window always stay.

### Derived rather than reported

- **Cache clock.** It restarts at each main-thread request and runs for the TTL of the cache tier.
  The mod API reports cache tokens but not their tier (5m or 1h), so at the end of each turn the HUD
  reads the session transcript and stops after the first cache write it finds (three tries at most
  per session; transcripts over 32 MB are skipped). The tier is kept in the mod's store as the next
  session's first guess. A `~` before the countdown marks a guess.
- **Re-cache tokens.** The last request's input, cache-read, cache-write and output tokens: the
  prompt the next request sends again.
- **Resumed session.** `classic.SessionStart` reports how long ago the session last answered and
  whether that outlived the cache. The HUD therefore shows the expired cache at once, without reading
  the transcript.
- **Model switch.** It forfeits the cache, so the HUD shows it as expired until the next request.

## Known limitations

- **A model or effort switch shows late.** Claude Code tells a mod nothing when you pick another
  model or effort level, and gives it no way to read the effort while Claude is idle. The HUD learns
  both from the next request Claude sends, so after a switch it shows the old values until Claude
  starts working again. The model alone could be polled, but then a switch would show the new model
  beside the old effort, so the HUD keeps both on the request.
- **`/hud` waits during a compaction.** Claude Code holds every slash command until a compaction
  ends. `✕ HIDE` on the screen still works then, since it is not a command.

## Commands

| Command | Effect |
| --- | --- |
| `/hud` | Turns it on or off. |
| `/hud on`, `/hud off` | Sets it on or off. |
| `/hud above` | Shows it as a band above the prompt (the default). Ctrl+X Ctrl+A or `[-]` folds the band away. |
| `/hud below` | Shows it under the prompt, above the hint line. |
| `/hud alerts` | Lists the toast thresholds. |
| `/hud alerts context 80,90 usage 90` | Toasts once per threshold, again only after the gauge falls 5 points below it. `usage` covers the 5-hour and 7-day windows. |
| `/hud alerts off` | Turns all toasts off. Toasts are off by default. |
| `/hud debug` | What the click layer over the desktop's screen has reported: whether it runs and its size in cells, any failure the engine reported, and its last pointer events (where each click landed, and which control that hit). |

The settings live in the mod's own `$.store`, not in settings.json, so `/hud` works in the desktop
app too, where `/config` isn't available.

## What it can reach

- **Reads.** `$.session` (usage, model, cwd, repository root, attached surfaces), `$.settings`
  (`effortLevel` only), `$.agent.list()`, and the session transcript (`classic.Stop`'s
  `transcript_path`), read for the cache tier as described above.
- **Runs.** One command: `git --no-optional-locks status --porcelain=v2 --branch`, in the session's
  directory, with a 5-second timeout. `--no-optional-locks` keeps git from refreshing the index, so
  the run writes nothing. It runs at session start, at the start of each turn, and after an `Edit`,
  `Write`, `MultiEdit`, `NotebookEdit` or `Bash` call, at most once every 5 seconds. It never runs
  while the HUD is off, or when no surface is attached (`claude -p`).
- **Runs on a press.** `/compact`, through `$.command.run`, only after the second press of the
  compact control, and never while a compaction is queued or running. The click layer sends the
  hooks module its size, the pointer's clicks, entries and exits with where they landed, and counts
  of moves and presses; nothing else.
- **Writes.** Its own `$.state` values (declared in `types/index.d.ts`) and keys in its own
  `$.store`: `prefs`, `ttl`, and `debug` (what the click layer reported, which
  `/hud debug` shows). It writes no files.
- **Never.** No model calls, no network, no `$.fs.write`, and no edits to settings. It refuses or
  rewrites nothing: each hook at a gating site passes through, and a `.catch` passes the event on if
  the HUD itself fails.

## The project name, for a screen mask

The project's name lives in one place: the state value `hud.project`. Every row reads it, and no
toast, command reply or other part of the HUD names the project. The HUD writes it at session start
and at every git refresh. A mask mod rewrites it as the value passes:

```ts
on('state.set', { plugin: 'hud', key: 'project' }, ($, e, next) => next({ ...e, value: '▒▒▒' }))
```

A mask switched on mid-session applies at the next git refresh (the next turn, or `/hud off` then
`/hud on`). The branch name is a separate value, `hud.repo`.

## Files

- `hooks/register.tsx`: the hooks, and every `$` call.
- `hooks/panel.ts`: what each line says, its tones, the palette, and the drop order. Pure.
- `hooks/crt.ts`: the desktop's CRT screen as an SVG document, and where its controls are. Pure.
- `hooks/hit.tsx`: the click layer over the desktop's screen, a `Client` surface module.
- `hooks/alerts.ts`: the threshold toasts. Pure.
- `hooks/parse.ts`: git's porcelain output, the transcript's cache tier, and `/hud`'s arguments. Pure.
- `types/index.d.ts`: the state contract.
- `tests/hud.test.ts`: `claude plugin test .`

## Development

```sh
claude plugin validate .
claude plugin test .
```
