// The renderer build refuses an unpatched xterm.js (electron.vite.xtermPatch.ts). The stock and patched texts are the two
// sides of the patch's own lib/xterm.mjs hunk, so the test holds whichever state this checkout's node_modules is in.
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import config from './electron.vite.config'
import { xtermPatchProblem } from './electron.vite.xtermPatch'

const patch = readFileSync(new URL('./patches/@xterm+xterm+6.0.0.patch', import.meta.url), 'utf8').split('\n')
const hunk = patch.findIndex((l) => l === 'diff --git a/node_modules/@xterm/xterm/lib/xterm.mjs b/node_modules/@xterm/xterm/lib/xterm.mjs')
const stockLine = patch.slice(hunk).find((l) => l.startsWith('-') && !l.startsWith('---'))!.slice(1)
const patchedLine = patch.slice(hunk).find((l) => l.startsWith('+') && !l.startsWith('+++'))!.slice(1)

describe('the xterm patch guard', () => {
  it('passes the patched lib/xterm.mjs', () => {
    expect(xtermPatchProblem(`/** xterm */\n${patchedLine}\nexport{Dl as Terminal};`, 'lib/xterm.mjs')).toBeNull()
  })

  it('refuses the stock one, naming the file and how to patch it', () => {
    const problem = xtermPatchProblem(`/** xterm */\n${stockLine}\nexport{Dl as Terminal};`, 'D:/x/node_modules/@xterm/xterm/lib/xterm.mjs')
    expect(problem).toContain('D:/x/node_modules/@xterm/xterm/lib/xterm.mjs')
    expect(problem).toContain('npm install')
    expect(problem).toContain('npx patch-package')
  })

  it('is one of the renderer build’s plugins, so npm run dev and npm run build both stop', () => {
    const renderer = (config as { renderer?: { plugins?: unknown[] } }).renderer
    const plugins = [renderer?.plugins ?? []].flat(Infinity) as ({ name?: string } | null)[]
    expect(plugins.some((p) => p?.name === 'astera-xterm-patch')).toBe(true)
  })
})
