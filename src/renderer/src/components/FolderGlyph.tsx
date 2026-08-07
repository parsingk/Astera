/** Folder glyph — shared across the sidebar. Used by AccountPanel's 'import' button (16),
 *  HistoryBrowser's project rows (14) and WorktreePanel's worktree rows (14). All three used to inline the
 *  same path separately; they were consolidated while fixing the worktree panel's use of the 📁 emoji (it
 *  shows up next to the history rows, so they had to match).
 *  FileIcon's folder/folder-open are a separate set for the file tree only (stroke 1.3), so they are not
 *  included here. */
export function FolderGlyph({ size = 14 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 4.5c0-.55.45-1 1-1h3l1.2 1.5H13c.55 0 1 .45 1 1V12c0 .55-.45 1-1 1H3c-.55 0-1-.45-1-1V4.5Z" />
    </svg>
  )
}
