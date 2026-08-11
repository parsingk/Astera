/** Branch glyph for the worktree base-branch picker — two commit nodes on a trunk with a third branching
 *  off it, the octicon git-branch reading. Circles and lines only, so it stays legible at 14px where a
 *  filled mark would turn to mush.
 *  Kept beside FolderGlyph rather than folded into FileIcon: that set is the file tree's, sized and stroked
 *  for it, and this is chrome for a form control. */
export function BranchGlyph({ size = 14 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="4.5" cy="3.5" r="1.75" />
      <circle cx="4.5" cy="12.5" r="1.75" />
      <circle cx="11.5" cy="6" r="1.75" />
      <path d="M4.5 5.25v5.5M11.5 7.75c0 2-1.5 3-3.5 3.25" />
    </svg>
  )
}
