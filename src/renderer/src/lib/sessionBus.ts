type Listener = (data: string) => void

/** Cap on how much output is held until a listener (TerminalView) attaches.
 *
 *  That this was safe without a cap so far was luck — manager.ts's backpressure waited for the
 *  renderer's ack and permanently stopped the PTY at 100KB (highWater), and that stop acted as the cap.
 *  Attaching an automatic release (RESUME_FAILSAFE_MS) to that stop removed the accidental cap, so a
 *  session with no tab yet that keeps producing output would grow this Map without bound.
 *
 *  It has to be larger than highWater (100KB) so nothing is cut during the normal mount window (spawn →
 *  TerminalView attach). 256KB it is. On overflow it **drops the front and keeps the tail** — what the
 *  terminal wants to replay is the recent output.
 *
 *  **This cap is a pair with manager.ts's failsafe — do not have one without the other.** The trimmed
 *  front is never acked, so with this cap but no failsafe the ack at attach time falls short by exactly
 *  what was trimmed, leaving a positive offset in pendingBytes that can put that session into a
 *  permanent pause. That offset does not actually occur because the failsafe periodically resets the
 *  counter to 0 while there is no consumer. */
const BUFFER_CAP = 256 * 1024
/** The point at which the trim actually happens once the cap is exceeded. Slicing on every chunk means
 *  that past the cap every chunk flattens 256KB (a V8 ConsString flatten), which multiplies the copying
 *  by 64 for 4KB chunks. It is allowed up to 1.5× and trimmed in one go — the maximum held is 384KB,
 *  which is still bounded. */
const BUFFER_TRIM_AT = BUFFER_CAP * 1.5

const buffers = new Map<string, string>()
const listeners = new Map<string, Listener>()
let initialized = false

export function init(): void {
  if (initialized) return
  initialized = true
  window.api.on('session:data', ({ sessionId, data }) => {
    const listener = listeners.get(sessionId)
    if (listener) listener(data)
    else {
      const next = (buffers.get(sessionId) ?? '') + data
      buffers.set(sessionId, next.length > BUFFER_TRIM_AT ? next.slice(-BUFFER_CAP) : next)
    }
  })
}

export function attach(sessionId: string, listener: Listener): () => void {
  const buffered = buffers.get(sessionId)
  if (buffered) {
    buffers.delete(sessionId)
    listener(buffered)
  }
  listeners.set(sessionId, listener)
  return () => {
    listeners.delete(sessionId)
    buffers.delete(sessionId)
  }
}

export function discard(sessionId: string): void {
  listeners.delete(sessionId)
  buffers.delete(sessionId)
}

// ---- input direction: paste into a session's terminal ----
//
// Everything above carries PTY output *to* a terminal. This carries text *into* one, through the
// terminal's own paste — the Ctrl+V path. That matters: a raw `sessions.write` turns the first newline
// into Enter and submits a half-built prompt, while xterm's paste wraps the text in bracketed paste,
// which Claude Code receives as one paste and leaves for the user to send.

const pasters = new Map<string, (text: string) => void>()

/** TerminalView registers its xterm's paste when it mounts. Returns the unregister. */
export function registerPaste(sessionId: string, paste: (text: string) => void): () => void {
  pasters.set(sessionId, paste)
  return () => {
    if (pasters.get(sessionId) === paste) pasters.delete(sessionId)
  }
}

/** Pastes into that session's terminal. false when no terminal is registered for the id — the tab is
 *  gone, or has not mounted yet. Session slots stay mounted off screen, so a live session always has one. */
export function pasteInto(sessionId: string, text: string): boolean {
  const paste = pasters.get(sessionId)
  if (!paste) return false
  paste(text)
  return true
}
