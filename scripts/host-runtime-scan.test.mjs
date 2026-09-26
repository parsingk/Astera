import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { bundlePackages, dependencyClosure } from './host-runtime-scan.mjs'

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

/** A node_modules tree under a temp root: { 'a': { dependencies: {…} }, 'a/node_modules/b': {…} }. */
function tree(pkgs, extra = {}) {
  dir = mkdtempSync(join(tmpdir(), 'host-runtime-closure-'))
  for (const [rel, manifest] of Object.entries(pkgs)) {
    const at = join(dir, 'node_modules', ...rel.split('/'))
    mkdirSync(at, { recursive: true })
    writeFileSync(join(at, 'package.json'), JSON.stringify({ name: rel.split('/node_modules/').pop(), ...manifest }))
  }
  for (const [rel, text] of Object.entries(extra)) {
    mkdirSync(join(dir, ...rel.split('/').slice(0, -1)), { recursive: true })
    writeFileSync(join(dir, ...rel.split('/')), text)
  }
  return dir
}

describe('dependencyClosure (Slack in the Host Task 2, spec §3.7)', () => {
  it('keeps a nested copy where npm put it, and resolves a peer', () => {
    const root = tree({
      a: { dependencies: { b: '2', '@types/node': '*' }, peerDependencies: { u: '1' } },
      'a/node_modules/b': {},
      b: {},
      c: { dependencies: { b: '1' }, optionalDependencies: { gone: '1' } },
      u: {},
      '@types/node': { dependencies: { 'undici-types': '*' } },
      'undici-types': {}
    })
    expect(dependencyClosure(root, ['a', 'c'])).toEqual([
      'node_modules/a',
      'node_modules/a/node_modules/b',
      'node_modules/b',
      'node_modules/c',
      'node_modules/u'
    ])
  })

  it('refuses a required package that is not installed, naming it', () => {
    const root = tree({ a: { dependencies: { missing: '1' } } })
    expect(() => dependencyClosure(root, ['a'])).toThrow(/missing/)
  })

  it('refuses a native package unless it is allowed', () => {
    const root = tree({ n: {}, g: { gypfile: true }, pty: {} }, {
      'node_modules/n/build/Release/n.node': 'x',
      'node_modules/pty/binding.gyp': '{}'
    })
    expect(() => dependencyClosure(root, ['n'])).toThrow(/n is a native module/)
    expect(() => dependencyClosure(root, ['g'])).toThrow(/g is a native module/)
    expect(dependencyClosure(root, ['pty'], { allowNative: ['pty'] })).toEqual(['node_modules/pty'])
  })

  // The real tree: what the Host bundle loads for Slack must all be shipped (spec §3.7).
  it('covers @slack/socket-mode, @slack/web-api and undici in this repository', () => {
    const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
    const got = dependencyClosure(repo, ['@slack/socket-mode', '@slack/web-api'])
    for (const want of ['node_modules/@slack/socket-mode', 'node_modules/@slack/web-api', 'node_modules/undici'])
      expect(got).toContain(want)
    expect(got.some((p) => p.includes('@types/') || p.endsWith('undici-types'))).toBe(false)
  })
})
