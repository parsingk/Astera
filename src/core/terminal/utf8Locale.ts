/**
 * The LC_CTYPE to add so that programs started from this environment read text as UTF-8, or null when none is needed.
 *
 * **Why.** A macOS app started from the Finder or the Dock gets no LANG and no LC_* at all (Terminal.app and iTerm set
 * them for the shells they start; launchd does not), and everything Astera starts inherits that: the Host, the
 * sessions, the terminals and every tool run in them, all under the C locale. Most of it copes, but pbcopy does not:
 * given text with any non-ASCII character it writes an EMPTY clipboard, without an error. Claude Code copies a mouse
 * selection with pbcopy, said "copied N chars to clipboard", and a paste then gave nothing (measured 2026-11-25:
 * '한글' piped to pbcopy with no locale variable left 0 bytes; with LC_CTYPE=en_US.UTF-8, all of it).
 *
 * **Only LC_CTYPE.** It decides how bytes become characters, which is the whole fault. LANG would also move message
 * catalogues, dates and number formats, which output read by code may depend on; macOS programs already take their
 * message language from the system's preferences when no variable names one (git answers in Korean either way).
 * en_US.UTF-8 because every macOS has it, and because ssh sends LC_* along by default: a server is far more likely to
 * have it than the system's own language's locale.
 *
 * Any locale the environment already names is left alone, C included: someone set it.
 */
export function utf8CtypeFor(env: Record<string, string | undefined>, platform: NodeJS.Platform): string | null {
  if (platform !== 'darwin') return null
  if (env.LC_ALL || env.LC_CTYPE || env.LANG) return null
  return 'en_US.UTF-8'
}
