/**
 * xterm options every terminal in the app is built with, so that a selection can be forced over a program that takes
 * the mouse: Claude Code's fullscreen view, vim, htop.
 *
 * While such a program has mouse tracking on, a drag goes to it, not to the terminal, and whatever it does with the
 * selection is the only copy there is (Claude Code's runs pbcopy, which the C locale an app from the Finder inherits
 * turned into an empty clipboard for non-ASCII text; core/terminal/utf8Locale.ts). xterm lets a drag through to its own
 * selection anyway with Shift on Windows and Linux, but on macOS only with Option, and only with this option on
 * (SelectionService.shouldForceSelection): off by default, an Option-drag went to the program like any drag. The
 * selection it makes is copied by the terminal's own Cmd+C, through the app's clipboard.
 *
 * It changes nothing without Option, and nothing where no program takes the mouse.
 */
export const FORCED_SELECTION_OPTIONS = { macOptionClickForcesSelection: true } as const
