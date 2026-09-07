import { describe, it, expect } from 'vitest'
import vm from 'node:vm'
import { clickScript, embedJson, fillScript, pressScript, snapshotScript, waitForScript } from './guestScripts'

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
    }
  })
})
