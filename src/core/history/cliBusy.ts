/**
 * Whether the CLI is in the middle of something, read off the line it prints about itself.
 *
 * The alternative was to infer it from the transcript's shape — a user turn with nothing after it —
 * and that is wrong whenever the CLI answers somewhere other than the transcript. `/model`, `/effort`
 * and `/clear` all leave exactly that shape behind for good, so the view sat there saying the CLI was
 * thinking while it was idle at its prompt, with the composer shut behind the same reading. What the
 * CLI is doing is something it says out loud; this reads that instead of guessing.
 *
 * Both shapes below are measured, not supposed (2026-09-14):
 *
 *   claude working   `✽ Herding…`, `· Herding… (9s · ↓ 326 tokens)`,
 *                    `✢ Herding… (running stop hooks… 0/4 · 13s)`  — the glyph cycles
 *   claude finished  `✻ Cooked for 13s · done 오후 12:51`
 *   codex working    `◦ Working (22s • esc to interrupt)`
 *
 * The claude rule is the ellipsis directly after the word: it is there for every frame of a run and
 * gone the moment the line becomes "... for 13s · done". The codex rule is the offer to interrupt,
 * which is what that CLI prints instead. Neither reads the words themselves — claude picks a different
 * gerund every time, and it translates.
 */

/** `✻ Herding…` — a glyph that is neither space nor letter, a word, and the ellipsis that says it is
 *  still going. The done line has `for 13s` where the ellipsis would be, so it does not match. */
const CLAUDE_WORKING = /^\s*[^\s\w]\s+\w+…/u

/** What codex prints while it works, and claude too on the frames where it offers the key. */
const INTERRUPTIBLE = /esc to interrupt/i

/** True while the CLI is working. False for a screen that cannot be read — a caller treating that as
 *  "not busy" is right: nothing to read means nothing to report. */
export function cliBusyOf(lines: readonly string[]): boolean {
  return lines.some((line) => CLAUDE_WORKING.test(line) || INTERRUPTIBLE.test(line))
}
