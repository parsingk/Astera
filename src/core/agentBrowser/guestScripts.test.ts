import { describe, it, expect } from 'vitest'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { clickScript, embedJson, fillScript, pressScript, snapshotScript, waitForScript } from './guestScripts'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** The names this module's two source files declare or import at module scope: a function body that
 *  mentions any of them (other than its own name) is reaching outside itself, and would be
 *  `undefined` in the guest. Parsed from the source text rather than hand-maintained, so it stays
 *  right when either file changes. */
function moduleScopeNames(src: string): Set<string> {
  const names = new Set<string>()
  for (const line of src.split('\n')) {
    const decl = line.match(/^(?:export\s+)?(?:function|const|let|var|interface|type)\s+(\w+)/)
    if (decl) names.add(decl[1])
    const imported = line.match(/^import\s+(?:type\s+)?\{([^}]+)\}\s+from/)
    if (imported) {
      for (const part of imported[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop()
        if (name) names.add(name)
      }
    }
  }
  return names
}

/** Balances braces from a `function name(...) {` signature to its closing `}`, so the comparison in
 *  the "stays identical to its copy" test does not depend on where either copy sits in its file. */
function extractFunction(src: string, signature: string): string {
  const start = src.indexOf(signature)
  if (start === -1) throw new Error(`signature not found: ${signature}`)
  const braceStart = src.indexOf('{', start)
  let depth = 0
  let end = braceStart
  for (; end < src.length; end += 1) {
    if (src[end] === '{') depth += 1
    else if (src[end] === '}') {
      depth -= 1
      if (depth === 0) break
    }
  }
  return src.slice(start, end + 1)
}

/** The guest compiles the script before it runs it; so does this — a body that does not parse would
 *  fail with a message from Chromium, not from us. */
const compiles = (src: string): void => { new vm.Script(src) }

describe('guest scripts', () => {
  it('every builder produces an expression that compiles', () => {
    for (const s of [snapshotScript(), clickScript('#a', false), clickScript('#a', true), fillScript('#e', 'x'), pressScript('Enter'), waitForScript('.done', 1000)]) {
      compiles(s)
      expect(s.startsWith('(')).toBe(true)
    }
  })

  it('embeds arguments as JSON that cannot end the script or the line', () => {
    // The two line separators are built from code points on purpose: a \u2028 escape typed into
    // an editor or a tool can come out as the character itself, and a backslash followed by that
    // character inside a JS string is a line continuation: the separator silently disappears.
    const seps = String.fromCharCode(0x2028) + String.fromCharCode(0x2029)
    const s = embedJson('</script><b>&amp;' + seps)
    expect(s).not.toContain('</script>')
    expect(s).not.toContain('<b>')
    expect(s).not.toContain('&amp;')
    expect(s).not.toContain(String.fromCharCode(0x2028))
    expect(s).not.toContain(String.fromCharCode(0x2029))
    expect(JSON.parse(s)).toBe('</script><b>&amp;' + seps)
  })

  it('a selector containing quotes and a closing script tag is carried intact', () => {
    const sel = `a[href="</script>'x"]`
    const s = clickScript(sel, false)
    compiles(s)
    // The selector is embedded once, as a JSON string the IIFE receives
    expect(s).toContain(embedJson(sel))
    expect(s).toContain('false)')
  })

  it('the runtime bodies reference no outside identifier from this module', () => {
    // Anything the body needs must be inside it: toString() carries only the body. A leaked reference
    // is `undefined` in the guest — the constraint pickRuntime.ts documents.
    for (const s of [snapshotScript(), clickScript('#a', true), fillScript('#e', 'x'), pressScript('a'), waitForScript('.d', 10)]) {
      expect(s).not.toMatch(/\bSNAPSHOT_BUDGET\b/)
      expect(s).not.toMatch(/\bembedJson\b/)
      expect(s).not.toMatch(/\bcontainsSecret\b/)
      // A bundler or minifier artifact leaking into a stringified body would show up as one of
      // these — the same check pickScripts.test.ts makes for the renderer's copy of this pattern.
      expect(s).not.toMatch(/\bimport\b|\brequire\(|__vite|\bexports\b/)
    }
  })

  it('no emitted string mentions a module-scope name other than its own runtime function', () => {
    const runtimeSrc = readFileSync(path.join(HERE, 'guestRuntime.ts'), 'utf8')
    const scriptsSrc = readFileSync(path.join(HERE, 'guestScripts.ts'), 'utf8')
    const names = new Set([...moduleScopeNames(runtimeSrc), ...moduleScopeNames(scriptsSrc)])
    const cases: Array<[string, string]> = [
      [snapshotScript(), 'snapshotRuntime'],
      [clickScript('#a', true), 'clickRuntime'],
      [fillScript('#e', 'x'), 'fillRuntime'],
      [pressScript('a'), 'pressRuntime'],
      [waitForScript('.d', 10), 'waitForRuntime']
    ]
    for (const [src, ownName] of cases) {
      for (const name of names) {
        if (name === ownName) continue
        expect(src).not.toMatch(new RegExp(`\\b${name}\\b`))
      }
    }
  })

  it('selectorOf stays identical to its copy in pickRuntime.ts', () => {
    // Both files carry a "change one copy, change the other" comment; nothing else enforces it.
    const runtimeSrc = readFileSync(path.join(HERE, 'guestRuntime.ts'), 'utf8')
    const pickSrc = readFileSync(path.join(HERE, '../../renderer/src/lib/pickRuntime.ts'), 'utf8')
    const signature = 'function selectorOf(el: Element): string {'
    expect(extractFunction(runtimeSrc, signature)).toBe(extractFunction(pickSrc, signature))
  })
})
