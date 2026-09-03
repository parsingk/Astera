import path from 'node:path'

/** The cap on a session title.
 *
 *  The title is not only a tab label. It is the prefix of every Slack message the session posts
 *  (`[title · account] …`) and the title of its desktop notifications, and neither handles unbounded
 *  text well — Slack's own length limit is spent on the message, and an OS toast simply truncates.
 *  Nobody types 120 characters into a tab by accident; a pasted paragraph is the realistic way this
 *  gets long, and that is what this stops. */
const MAX_TITLE = 120

/** What a session is called when nobody has named it: the project folder.
 *
 *  A path with no basename (a drive root) falls back to the path itself rather than to an empty tab —
 *  the choice spawn has always made, kept here so renaming and spawning cannot disagree about it. */
export function defaultSessionTitle(cwd: string): string {
  return path.basename(cwd) || cwd
}

/** What to store for a title a person typed.
 *
 *  Clearing the box is the only way to ask for the default name back, so an empty result means the
 *  default rather than an empty tab. Inner whitespace is collapsed because the readers are all
 *  single-line: a newline breaks Slack's prefix and is dropped by a notification. */
export function normalizeSessionTitle(input: string, cwd: string): string {
  const collapsed = input.replace(/\s+/g, ' ').trim()
  if (collapsed === '') return defaultSessionTitle(cwd)
  return collapsed.slice(0, MAX_TITLE)
}
