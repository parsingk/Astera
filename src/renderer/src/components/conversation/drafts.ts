/**
 * What was typed into a session's composer and not sent, kept while that composer is not on screen.
 *
 * The conversation pane is mounted only while it is showing (PaneGrid's own comment says why), so
 * switching to the terminal, to another tab, or to another session takes the composer down and
 * whatever was half-written in it with it. That is the whole of what this holds on to.
 *
 * In memory, for the app's life. Not on disk: a draft is a sentence someone is in the middle of, and
 * the thing that loses it is a tab click, not a restart. Writing every keystroke's worth of someone's
 * unsent text to disk would be a bigger promise than the problem asks for.
 */
const drafts = new Map<string, string>()

/** Hold on to what is in the composer, or forget it when there is nothing worth keeping. */
export function keepDraft(sessionId: string, text: string): void {
  if (text.trim() === '') drafts.delete(sessionId)
  else drafts.set(sessionId, text)
}

/** What was left in this session's composer, or the empty string. Not consumed: coming back twice
 *  should find it both times, and only sending it or emptying it takes it away. */
export function draftOf(sessionId: string): string {
  return drafts.get(sessionId) ?? ''
}

/** It was sent, or the session is gone. */
export function forgetDraft(sessionId: string): void {
  drafts.delete(sessionId)
}
