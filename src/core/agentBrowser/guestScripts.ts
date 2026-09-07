// Turns guestRuntime.ts's functions into strings the agent's page can run: the compiled body from
// Function.prototype.toString(), wrapped in an IIFE with JSON-embedded arguments. The same trick as
// src/renderer/src/lib/pickScripts.ts; duplicated here because main, not the renderer, injects these,
// and main cannot import renderer files. Change one copy, change the other.
import { clickRuntime, fillRuntime, pressRuntime, snapshotRuntime, waitForRuntime } from './guestRuntime'
import { SNAPSHOT_BUDGET } from './snapshot'

/** JSON that is safe inside a script string: `<`, `>`, `&` and the two line separators are escaped,
 *  so a value containing `</script>` or U+2028 cannot end the script or the line. */
// The two line separators are addressed by code point, not by a \u2028 escape in the source: an
// escape typed into an editor or a tool can arrive as the character itself, and a backslash
// followed by that character inside a string literal is a line continuation, which would make
// this function delete separators instead of escaping them. pickScripts.ts predates this note.
const LINE_SEPARATOR = String.fromCharCode(0x2028)
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029)

export function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(new RegExp(LINE_SEPARATOR, 'g'), '\\u' + '2028')
    .replace(new RegExp(PARAGRAPH_SEPARATOR, 'g'), '\\u' + '2029')
}

const iife = (fn: (...args: never[]) => unknown, ...args: unknown[]): string =>
  `(${fn.toString()})(${args.map(embedJson).join(', ')})`

export function snapshotScript(): string {
  const { interactive, headings, landmarks, text, name, selector, heading, summary } = SNAPSHOT_BUDGET
  return iife(snapshotRuntime, { interactive, headings, landmarks, text, name, selector, heading, summary })
}

export function clickScript(sel: string, followLink: boolean): string {
  return iife(clickRuntime, sel, followLink)
}

export function fillScript(sel: string, text: string): string {
  return iife(fillRuntime, sel, text)
}

export function pressScript(key: string): string {
  return iife(pressRuntime, key)
}

export function waitForScript(sel: string, ms: number): string {
  return iife(waitForRuntime, sel, ms)
}
