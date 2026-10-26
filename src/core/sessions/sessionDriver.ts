// How a coordinator hands one message to a session without knowing what kind of session it is — the
// chat-sessions slice 4 design's seam ① (§3, §5.4). A terminal session takes the text and an Enter
// 150 ms later (the paste-then-Enter convention rolling and the scheduler have always used); a chat
// session takes one `chat.send`. Slice 4a uses this from the scheduler; 4b (Slack) and 4c (rolling)
// route their sends through it too.
//
// In core rather than main because the Host types into sessions too (`astera sessions send`, answered
// by the command layer inside the Host bundle), and it must use this same paste-then-Enter convention
// rather than a second copy of the delay.

/** The gap between the command text and Enter on a pty — time for the TUI to digest the paste. */
export const ENTER_DELAY_MS = 150
/** With the session's output to go by, Enter waits until the TUI has shown the text and been quiet this long. Codex
 *  takes a fast run of keys as a paste and swallows an Enter that comes within 120 ms of it, and through ConPTY a long
 *  text reaches it well after it was written, so a fixed 150 ms left a long message in its input unsent (found on the
 *  dev app, 2026-10-26; openai/codex#56982 reports it with a 200 ms gap). Its last key comes before the output it draws. */
export const ENTER_QUIET_MS = 200
/** How long Enter waits for that quiet at most: a session that keeps drawing (a spinner) never goes quiet. */
export const ENTER_MAX_WAIT_MS = 5000

/** A delivery made for a person (a Slack reply): carried down to the write, where the Host tells a person's prompt by it
 *  (observe deferred fix round 2, Important a). A schedule's or a roll's delivery carries none. */
export type ForPerson = { person: true } | undefined

export interface SessionDriver {
  /** One message to the session. Resolves once it has been handed to the CLI (for a pty: after the
   *  Enter went out); rejects when the CLI refused it or the session is gone. */
  deliver(sessionId: string, text: string, by?: ForPerson): Promise<void>
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function ptyDriver(deps: {
  write(sessionId: string, data: string, by?: ForPerson): void
  wait?: (ms: number) => Promise<void>
  /** When the session's pty last printed anything (epoch ms), null for never. Given, Enter waits for the quiet after
   *  the text (ENTER_QUIET_MS); left out, it goes ENTER_DELAY_MS after the text as it always did. */
  lastOutputAt?: (sessionId: string) => number | null
}): SessionDriver {
  const wait = deps.wait ?? sleep
  const lastOutputAt = deps.lastOutputAt
  return {
    async deliver(sessionId, text, by) {
      const wroteAt = Date.now()
      deps.write(sessionId, text, by) // a throw here is the rejection — no Enter follows a failed paste
      await wait(ENTER_DELAY_MS)
      // Output after the text, then quiet: the TUI has taken the text in. Output from before does not count, as the
      // text may not have reached it yet
      while (lastOutputAt) {
        const now = Date.now()
        const last = lastOutputAt(sessionId)
        const since = last !== null && last >= wroteAt ? last : null
        const left = ENTER_MAX_WAIT_MS - (now - wroteAt)
        if (left <= 0 || (since !== null && now - since >= ENTER_QUIET_MS)) break
        await wait(Math.min(left, since !== null ? since + ENTER_QUIET_MS - now : ENTER_QUIET_MS))
      }
      deps.write(sessionId, '\r', by)
    }
  }
}

export function chatDriver(deps: { send(sessionId: string, text: string, by?: ForPerson): Promise<void> }): SessionDriver {
  return {
    deliver: (sessionId, text, by) => deps.send(sessionId, text, by)
  }
}

/** Picks the driver by asking the kind on every call — never cached per id, because rolling re-keys
 *  an entry to a new session id and the new one is judged on its own. */
export function routedDriver(
  isChat: (sessionId: string) => boolean,
  pty: SessionDriver,
  chat: SessionDriver
): SessionDriver {
  return {
    deliver: (sessionId, text, by) => (isChat(sessionId) ? chat : pty).deliver(sessionId, text, by)
  }
}
