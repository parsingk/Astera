import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bundlePackages } from './host-runtime-scan.mjs'

let dir
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

/** A bundle laid out as electron-vite emits it: host.js at the root, chunks beside it. */
function bundle(files) {
  dir = mkdtempSync(join(tmpdir(), 'host-runtime-scan-'))
  mkdirSync(join(dir, 'chunks'))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  return join(dir, 'host.js')
}

describe('bundlePackages', () => {
  it('collects the packages required in both quote styles, from host.js and the chunks it reaches', () => {
    const entry = bundle({
      'host.js': `const a = require("./chunks/a.js"); const i = require('ignore'); const fs = require("node:fs")`,
      'chunks/a.js': `const p = require("node-pty")`,
      'chunks/app-only.js': `const e = require("electron")`
    })
    expect(bundlePackages(entry)).toEqual(['ignore', 'node-pty'])
  })

  // src/host/sessions.ts loads @xterm/headless lazily. A scan that sees only require() shipped a
  // runtime without it, and `astera sessions read` failed with ERR_MODULE_NOT_FOUND under node.exe.
  it('collects the packages a dynamic import() loads, in both quote styles', () => {
    const entry = bundle({
      'host.js': `const a = require("./chunks/a.js"); const t = await import("@xterm/headless")`,
      'chunks/a.js': `const m = await import( 'lazy-pkg' ); const b = await import("node:path")`
    })
    expect(bundlePackages(entry)).toEqual(['@xterm/headless', 'lazy-pkg'])
  })

  it('leaves out an import() whose argument is not a literal, and relative ones', () => {
    const entry = bundle({
      'host.js': `const m = await import(input); const r = await import("./chunks/b.js")`,
      'chunks/b.js': ``
    })
    expect(bundlePackages(entry)).toEqual([])
  })
})
