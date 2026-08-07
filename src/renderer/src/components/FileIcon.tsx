import { memo } from 'react'
import type { IconId, IconTone } from '../../../core/files/icons'

/** File and folder type icons. id = the shape, tone = the color.
 *  The icons are monochrome currentColor and the color comes from the .fi--<tone> class — the same as the
 *  app's SVG convention. */

/** Document silhouette — shared by the glyph family. */
const DOC = (
  <>
    <path d="M9.2 1.9H4.4a.8.8 0 0 0-.8.8v10.6a.8.8 0 0 0 .8.8h7.2a.8.8 0 0 0 .8-.8V5.1z" />
    <path d="M9.2 1.9v3.2h3.2" />
  </>
)

/** The glyph text inside the document. 6.2px for two characters. Three characters use fontSize 5 plus
 *  textLength to force the width to 7.4u so it fits inside the 8.8u silhouette — tightening the tracking
 *  (a negative letterSpacing) together with textAnchor="middle" pulls the trailing space after the last
 *  character into the centering calculation, which pushes the ink block to the right, and per-font
 *  measurement showed PDF and DOC crossing both borders. */
function glyph(text: string): React.JSX.Element {
  const wide = text.length >= 3
  return (
    <text
      x="8"
      y="11.9"
      textAnchor="middle"
      fontSize={wide ? 5 : 6.2}
      textLength={wide ? 7.4 : undefined}
      lengthAdjust={wide ? 'spacingAndGlyphs' : undefined}
      fontWeight="600"
      fill="currentColor"
      stroke="none"
    >
      {text}
    </text>
  )
}

/** id → shape. Being a Record means typecheck catches a missing asset. */
const SHAPES: Record<IconId, React.JSX.Element> = {
  folder: (
    <path d="M1.9 12.9V4.2a.7.7 0 0 1 .7-.7h3.2l1.3 1.5h6.2a.7.7 0 0 1 .7.7v7.2a.7.7 0 0 1-.7.7H2.6a.7.7 0 0 1-.7-.7z" />
  ),
  'folder-open': (
    <>
      <path d="M1.9 12.9V4.2a.7.7 0 0 1 .7-.7h3.2l1.3 1.5h6.2a.7.7 0 0 1 .7.7v1.2" />
      <path d="M1.9 12.9l1.5-4.8a.7.7 0 0 1 .67-.5h10.1a.7.7 0 0 1 .67.9l-1.35 4.5a.7.7 0 0 1-.67.5H2.6a.7.7 0 0 1-.7-.6z" />
    </>
  ),
  file: DOC,
  label: DOC, // the label text is appended in FileIcon's body
  'code-braces': (
    <>
      {DOC}
      {glyph('{}')}
    </>
  ),
  'code-hash': (
    <>
      {DOC}
      {glyph('#')}
    </>
  ),
  'code-angle': (
    <>
      {DOC}
      {glyph('<>')}
    </>
  ),
  markdown: (
    <>
      {DOC}
      {glyph('MD')}
    </>
  ),
  'text-lines': (
    <>
      {DOC}
      <path d="M5.4 8.4h5.2M5.4 10.3h5.2M5.4 12.1h3.4" />
    </>
  ),
  // A standalone glyph with no document silhouette — the teeth continue into the rim as one path, so
  // there are no floating strokes.
  // 6 teeth: the half-angle is 20° at the root and 13° at the tip, but the tip radius is larger, so the
  // actual chord is slightly wider at the tip (2.66u) than at the root (2.26u) — going by the angles
  // alone it reads like a trapezoid, so take care. rInner 3.3 / rOuter 5.9 plus the center hole circle.
  // Coordinate extremes (including the 1.3 stroke width) x:[1.71,14.29] y:[1.6,14.4] — inside 0..16.
  gear: (
    <>
      <path d="M6.87 4.9L6.67 2.25L9.33 2.25L9.13 4.9L10.12 5.47L12.31 3.98L13.64 6.28L11.25 7.43L11.25 8.57L13.64 9.72L12.31 12.02L10.12 10.53L9.13 11.1L9.33 13.75L6.67 13.75L6.87 11.1L5.88 10.53L3.69 12.02L2.36 9.72L4.75 8.57L4.75 7.43L2.36 6.28L3.69 3.98L5.88 5.47Z" />
      <circle cx="8" cy="8" r="1.4" />
    </>
  ),
  git: (
    <>
      <circle cx="5" cy="4.2" r="1.6" />
      <circle cx="5" cy="11.8" r="1.6" />
      <circle cx="11" cy="7.4" r="1.6" />
      <path d="M5 5.8v4.4M6.6 4.7c2 .4 2.9 1.2 3.2 1.9" />
    </>
  ),
  container: (
    <>
      <rect x="2.2" y="8.9" width="5.1" height="4.3" rx=".6" />
      <rect x="8.1" y="8.9" width="5.7" height="4.3" rx=".6" />
      <rect x="5.1" y="4.2" width="5.7" height="4" rx=".6" />
    </>
  ),
  image: (
    <>
      <rect x="1.9" y="3.1" width="12.2" height="9.8" rx="1.1" />
      <circle cx="5.6" cy="6.4" r="1.15" />
      <path d="M2.3 12.2l3.4-3.5 2.3 2.3 2.2-2.6 3.6 4" />
    </>
  ),
  video: (
    <>
      <rect x="1.9" y="3.4" width="12.2" height="9.2" rx="1.1" />
      <path d="M6.6 6.4l3.9 2.6-3.9 2.6z" />
    </>
  ),
  audio: (
    <>
      <path d="M6.4 11.4V3.7l5.1-1.2v7.4" />
      <circle cx="4.7" cy="11.7" r="1.7" />
      <circle cx="9.8" cy="10.6" r="1.7" />
    </>
  ),
  archive: (
    <>
      <rect x="2.6" y="2.4" width="10.8" height="11.2" rx="1.1" />
      <path d="M8 2.4v2.2M8 6.1v1.6M8 9.2v1.5" />
      <circle cx="8" cy="12" r="1.1" />
    </>
  ),
  database: (
    <>
      <ellipse cx="8" cy="4.3" rx="5.1" ry="2.1" />
      <path d="M2.9 4.3v7.4c0 1.16 2.28 2.1 5.1 2.1s5.1-.94 5.1-2.1V4.3" />
      <path d="M2.9 8c0 1.16 2.28 2.1 5.1 2.1s5.1-.94 5.1-2.1" />
    </>
  ),
  terminal: (
    <>
      <rect x="1.9" y="2.8" width="12.2" height="10.4" rx="1.1" />
      <path d="M4.6 6.4l1.9 1.7-1.9 1.7M8.4 10.5h3.1" />
    </>
  ),
  table: (
    <>
      <rect x="1.9" y="3.1" width="12.2" height="9.8" rx="1.1" />
      <path d="M1.9 6.4h12.2M1.9 9.7h12.2M6.6 3.1v9.8" />
    </>
  ),
  lock: (
    <>
      <rect x="3.2" y="7.1" width="9.6" height="6.7" rx="1.2" />
      <path d="M5.6 7.1V5.4a2.4 2.4 0 0 1 4.8 0v1.7" />
    </>
  )
}

function FileIconBase({
  id,
  tone,
  label,
  badge
}: {
  id: IconId
  tone: IconTone
  label?: string
  badge?: 'test'
}): React.JSX.Element {
  return (
    <svg
      className={`fi fi--${tone}`}
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {SHAPES[id] ?? DOC}
      {id === 'label' && label ? glyph(label) : null}
      {badge === 'test' && (
        <circle cx="13" cy="13" r="1.7" fill="var(--fi-green)" stroke="var(--panel)" strokeWidth="1" />
      )}
    </svg>
  )
}

export const FileIcon = memo(FileIconBase)
