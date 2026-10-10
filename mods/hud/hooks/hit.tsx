// The click layer over the desktop's CRT screen: a transparent Client over the
// screen's header, as wide as the screen. It scales where a press lands across
// it into the SVG markup's pixels, finds the header control there (crt.ts), and
// posts the press to the hooks module. Only the column counts: the desktop
// reports it exactly, while its rows do not map onto the image.
//
// The surface sends one post per frame and a later one replaces an undelivered
// one, so a quick click's up could drop its down's press. Every post therefore
// carries the running count of presses and the last one's control, and the
// hooks module acts on each new count. The layer draws an empty box `rows`
// tall: the desktop sizes the region to what it draws, not to the Client's
// height. It also posts its size when that changes, and the pointer entering
// and leaving, so `/hud debug` can say what the desktop delivers. Moves are
// only counted: a post per move would be noise.
import type { ClientModule, ClientPointerEvent } from 'claude-code'

import type { HudHitMessage, HudHitPointer, HudHitProps } from '../types'

/** True between a down and its up, so the up of a press is not a second press. */
let isDown = false
let moves = 0
let presses = 0
let pressed: string | null = null
/** The region size last posted, `columns×rows`. */
let posted = ''

const Hit: ClientModule<HudHitProps> = (props, surface) => {
  const targetAt = (e: ClientPointerEvent): string | null => {
    if (surface.columns <= 0) return null
    const x = ((e.fine?.x ?? e.x + 0.5) / surface.columns) * props.width
    return props.targets.find(t => x >= t.left && x <= t.right)?.key ?? null
  }
  const send = (event: { pointer?: HudHitPointer; press?: string } = {}) => {
    const message: HudHitMessage = { columns: surface.columns, rows: surface.rows, moves, presses, pressed, ...event }
    surface.post(message)
  }

  // Set on every call, so the listener reads the targets of the latest props.
  surface.onPointer(e => {
    if (e.type === 'move') {
      moves += 1
      return
    }
    if (e.button === 'right' || e.button === 'middle') return
    const target = e.type === 'down' || e.type === 'up' ? targetAt(e) : null
    const wasDown = isDown
    if (e.type === 'down') isDown = true
    if (e.type === 'up') isDown = false
    // The down is the press; an up counts only where the surface sent no down before it.
    const press = target !== null && (e.type === 'down' || (e.type === 'up' && !wasDown)) ? target : undefined
    if (press) {
      presses += 1
      pressed = press
    }
    const pointer: HudHitPointer = { type: e.type, x: e.x, y: e.y, fine: e.fine ?? null, button: e.button ?? null, target }
    send(press ? { pointer, press } : { pointer })
  })

  const size = `${surface.columns}×${surface.rows}`
  if (size !== posted) {
    posted = size
    send()
  }

  const { Box } = surface.elements
  return <Box width={Math.max(1, surface.columns)} height={Math.max(1, props.rows)} />
}

export default Hit
