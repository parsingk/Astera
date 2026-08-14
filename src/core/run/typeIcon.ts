import type { FileIconSpec } from '../files/icons'
import type { RunConfigType } from './types'

/** The icon for a run configuration kind.
 *
 *  Drawn with the same vocabulary the file tree uses — a shape id plus a tone, with `label` for the
 *  marks that are really just a tool's initials. Two reasons not to ship the tools' own logos: they
 *  are trademarks, and a logo stripped to one colour to survive this theme stops being recognisable
 *  anyway, which is the only thing it was for.
 *
 *  `go` deliberately matches what `go.mod` already gets in the tree (a cyan GO label) — the same tool
 *  should not look like two different things depending on which pane you are looking at.
 *
 *  **No three-character labels here.** A label of three is squeezed to a fixed width to fit the
 *  document silhouette (FileIcon's textLength), and at the 14px these render at the result is an
 *  illegible smear that reads as the letters colliding with the outline. Rendered and looked at:
 *  "NPM" and "MVN" both failed that way, which is why npm and Maven carry a shape instead. */
export function runTypeIcon(type: RunConfigType): FileIconSpec {
  switch (type) {
    case 'shell':
      return { id: 'terminal', tone: 'gray' }
    case 'npm':
      // Red, as package.json is in the tree
      return { id: 'code-braces', tone: 'red' }
    case 'node':
      return { id: 'label', tone: 'green', label: 'JS' }
    case 'gradle':
      return { id: 'gear', tone: 'green' }
    case 'maven':
      return { id: 'archive', tone: 'orange' }
    case 'cargo':
      return { id: 'label', tone: 'orange', label: 'RS' }
    case 'go':
      return { id: 'label', tone: 'cyan', label: 'GO' }
  }
}
