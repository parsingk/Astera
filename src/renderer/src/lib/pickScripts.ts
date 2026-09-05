// Turns the runtime functions into strings the guest can run. `Function.prototype.toString` gives
// the compiled body; wrapping it in an IIFE with JSON-embedded arguments is the whole trick.
import type { Rect } from '../../../core/preview/pick/types'
import { badgesRuntime, cancelRuntime, chromeRuntime, highlightRuntime, pickerRuntime } from './pickRuntime'

export interface BadgeMarker {
  seq: number
  rectPage: Rect
  rectViewport: Rect
  isFixed: boolean
}

/** JSON that is safe inside a script string: `<`, `>`, `&` and the two line separators are escaped,
 *  so page text containing `</script>` or U+2028 cannot end the script or the line. */
export function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

const iife = (fn: (...args: never[]) => unknown, ...args: unknown[]): string =>
  `(${fn.toString()})(${args.map(embedJson).join(', ')})`

/** Arms the picker; the injected expression evaluates to a Promise for the next click's payload. */
export function armScript(): string {
  return iife(pickerRuntime)
}

export function cancelScript(): string {
  return iife(cancelRuntime)
}

/** Hides the picker's own overlay and badges, or puts them back. Wrapped around a capture so the
 *  shot is of the page rather than of our highlight. */
export function chromeScript(hidden: boolean): string {
  return iife(chromeRuntime, hidden)
}

export function badgesScript(markers: readonly BadgeMarker[]): string {
  return iife(badgesRuntime, markers)
}

/** Flash one annotation's element. Fixed elements are addressed by their viewport rect. */
export function highlightScript(marker: BadgeMarker): string {
  return iife(highlightRuntime, marker.isFixed ? marker.rectViewport : marker.rectPage, marker.isFixed)
}
