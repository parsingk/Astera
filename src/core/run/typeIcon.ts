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
    // Matches what the file tree already draws for a .py file (files/icons.ts's EXT table) — the same
    // tool should not look like two different things depending on which pane you are looking at.
    case 'python':
      return { id: 'label', tone: 'green', label: 'PY' }
    // pytest reuses the tree's own test-file marker (the badge, not a new shape) rather than inventing a
    // second way to say "this is a test" — it is Python's test runner, so the PY label still applies.
    case 'pytest':
      return { id: 'label', tone: 'green', label: 'PY', badge: 'test' }
    // Matches what the file tree already draws for docker-compose.yml/compose.yaml (files/icons.ts's
    // EXACT table) — the same reasoning as go and python above.
    case 'compose':
      return { id: 'container', tone: 'blue' }
    // Same shape as compose, deliberately: files/icons.ts itself does not distinguish Dockerfile from
    // docker-compose.yml (both get { container, blue }, see its EXACT table and its 'dockerfile' PREFIX
    // entry) — Docker is one tool with two config files, not two tools, so giving this kind a different
    // mark would invent a distinction the file tree does not draw.
    case 'dockerfile':
      return { id: 'container', tone: 'blue' }
    // Matches what the file tree already draws for a .cs file (files/icons.ts's EXT table: a purple C#
    // label) — the same reasoning as go, python and compose above. C# is the language of nearly every
    // .NET project, so its mark stands for the kind; F# gets no separate icon for the same reason npm
    // and Node.js share none: the kind is one tool, not one language.
    case 'dotnet':
      return { id: 'label', tone: 'purple', label: 'C#' }
  }
}
