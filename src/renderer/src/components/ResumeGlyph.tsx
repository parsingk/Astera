/** Resume glyph for the history session rows — a speech bubble whose right side opens into an arrow
 *  leaving it, the "carry this conversation on" reading. The bubble names *what* is resumed (a
 *  transcript, not a process) and the arrow names the action, which is what separates it from the
 *  glyphs it sits near.
 *
 *  **Why not `▶`**: in this app `▶` already means "run/start" everywhere it appears (RunToolbar,
 *  RunDetail, the worktree row's start-session button). Worse, this very panel draws project
 *  expansion with `▸`/`▾`, so a triangle in the session row would put two meanings on one shape in
 *  a single list.
 *
 *  **Why not a circular arrow**: `⟳` is this panel's own refresh button and `↺` is the shortcut
 *  settings' reset — a ring here would read as "reload", not "continue".
 *
 *  **Why not `↳`**: it reads as reply or nesting, and the session sublist already draws nesting with
 *  a left rail and an indent.
 *
 *  Drawn rather than set as text, for the reason JobIcons' lock pair gives: a glyph picks its own
 *  metrics and colour per font, and this has to inherit the button's (--text-dim → --text on hover).
 *  16 viewBox and currentColor are the app's SVG convention; the 1.5 stroke matches TrashIcon so the
 *  two weigh the same at row size. */
export function ResumeGlyph({ size = 13 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.6 3.1H3.7A2 2 0 0 0 1.7 5.1v3.3a2 2 0 0 0 2 2h.4v2.1l2.4-2.1h3.1" />
      <path d="M9.9 6.7h4.5" />
      <path d="M12.1 4.6 14.5 6.7 12.1 8.8" />
    </svg>
  )
}
