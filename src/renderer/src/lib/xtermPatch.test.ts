// The xterm.js fix ships as patches/@xterm+xterm+6.0.0.patch, which postinstall applies with patch-package (npm ci on
// every CI runner, npm install on a developer's machine). A patch only applies to the exact file it was made from, so
// the version is pinned, and the loader the input tests use (xtermFixtures.ts) applies it the same way when this
// node_modules was installed without it.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyPatchText, XTERM_PATCH } from './xtermFixtures'

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(path.dirname(XTERM_PATCH), '..')
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
}

describe('the xterm.js patch', () => {
  it('is for the exact xterm package.json pins and node_modules holds', () => {
    const version = /@xterm\+xterm\+(.+)\.patch$/.exec(XTERM_PATCH)?.[1]
    expect(version).toBe('6.0.0')
    expect(pkg.dependencies['@xterm/xterm']).toBe(version)
    expect((require('@xterm/xterm/package.json') as { version: string }).version).toBe(version)
  })

  it('is applied by postinstall, before anything else there runs', () => {
    expect(pkg.scripts.postinstall.startsWith('patch-package && ')).toBe(true)
    expect(pkg.devDependencies['patch-package']).toBeDefined()
  })

  it('applies to the installed lib/xterm.mjs whether postinstall patched it yet or not', () => {
    const file = 'node_modules/@xterm/xterm/lib/xterm.mjs'
    const installed = readFileSync(require.resolve('@xterm/xterm/lib/xterm.mjs'), 'utf8')
    const patch = readFileSync(XTERM_PATCH, 'utf8')
    const patched = applyPatchText(installed, patch, file)
    expect(patched).toContain('this._pendingCompositionSend=r')
    expect(applyPatchText(patched, patch, file)).toBe(patched)
  })
})

describe('applyPatchText', () => {
  const patch = [
    'diff --git a/node_modules/p/a.js b/node_modules/p/a.js',
    'index 1111111..2222222 100644',
    '--- a/node_modules/p/a.js',
    '+++ b/node_modules/p/a.js',
    '@@ -2 +2,2 @@',
    '-two',
    '+TWO',
    '+two and a half',
    '@@ -4,2 +5,2 @@ x',
    ' four',
    '-five',
    '+FIVE',
    ''
  ].join('\n')
  const stock = 'one\ntwo\nthree\nfour\nfive\n'
  const done = 'one\nTWO\ntwo and a half\nthree\nfour\nFIVE\n'

  it('applies each hunk in turn', () => {
    expect(applyPatchText(stock, patch, 'node_modules/p/a.js')).toBe(done)
  })
  it('leaves a file the patch is already in as it is', () => {
    expect(applyPatchText(done, patch, 'node_modules/p/a.js')).toBe(done)
  })
  it('throws on a file that is neither, and on a file the patch does not name', () => {
    expect(() => applyPatchText('one\nzwei\nthree\nfour\nfive\n', patch, 'node_modules/p/a.js')).toThrow(/redo the patch/)
    expect(() => applyPatchText(stock, patch, 'node_modules/p/b.js')).toThrow(/no hunk/)
  })
})
