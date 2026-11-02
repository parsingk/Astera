// The renderer is built only from a patched xterm.js. patches/@xterm+xterm+6.0.0.patch fixes Korean typed into a
// terminal tab being repeated or cut while the renderer is busy, and postinstall's patch-package applies it to
// node_modules. A node_modules installed without its scripts (`--ignore-scripts`, or a worktree sharing another
// checkout's), or one where patch-package failed — which off CI only prints — still holds the stock file, and an app
// built from it brings the bug back without a word. So the renderer build stops instead: this check runs at buildStart,
// which Vite calls for `npm run build` and when `npm run dev` starts its server.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { Plugin } from 'vite'

/** A name only the patched CompositionHelper has (the patch's own field for a finished composition's waiting send). */
export const XTERM_PATCH_MARKER = '_pendingCompositionSend'

/** Why the renderer must not be built from this lib/xterm.mjs text, or null when the patch is in it. */
export function xtermPatchProblem(libText: string, file: string): string | null {
  if (libText.includes(XTERM_PATCH_MARKER)) return null
  return (
    `${file} is the stock @xterm/xterm, without patches/@xterm+xterm+6.0.0.patch: Korean typed into a terminal tab ` +
    'would be repeated or cut while the app is busy. Run `npm install` in this checkout (postinstall applies the ' +
    'patch), or `npx patch-package` if its node_modules is already installed.'
  )
}

/** Stops the renderer build when the installed lib/xterm.mjs is not patched. */
export function xtermPatchPlugin(): Plugin {
  return {
    name: 'astera-xterm-patch',
    buildStart() {
      const file = createRequire(import.meta.url).resolve('@xterm/xterm/lib/xterm.mjs')
      const problem = xtermPatchProblem(readFileSync(file, 'utf8'), file)
      if (problem) throw new Error(problem)
    }
  }
}
