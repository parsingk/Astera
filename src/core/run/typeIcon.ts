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
 *  should not look like two different things depending on which pane you are looking at. */
export function runTypeIcon(type: RunConfigType): FileIconSpec {
  switch (type) {
    case 'shell':
      return { id: 'terminal', tone: 'gray' }
    case 'npm':
      // Red, as package.json is in the tree — npm's own mark is red too, so the tone reads right
      return { id: 'label', tone: 'red', label: 'npm' }
    case 'node':
      return { id: 'label', tone: 'green', label: 'JS' }
    case 'gradle':
      return { id: 'label', tone: 'green', label: 'GR' }
    case 'maven':
      return { id: 'label', tone: 'orange', label: 'MVN' }
    case 'cargo':
      return { id: 'label', tone: 'orange', label: 'RS' }
    case 'go':
      return { id: 'label', tone: 'cyan', label: 'GO' }
  }
}
