/** Keeps Secret values out of kubectl's stderr before it is shown or kept anywhere (C22). */

const PATCH_START = 'applying patch:'
const PATCH_END = /^to:/
/** A `"data":` or `"stringData":` key, also with the quotes escaped (inside the last-applied JSON string). */
const SECRET_FIELD = new RegExp('(' + String.fromCharCode(92, 92) + ')?"(data|stringData)(' + String.fromCharCode(92, 92) + ')?"\\s*:')
const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration'

export const PATCH_OMITTED = '<patch omitted>'
export const OMITTED = '<omitted>'

/**
 * kubectl's patch errors print the patch (`... applying patch:\n<patch>\nto:\n...`), which for a Secret holds its
 * values and the last-applied annotation. The lines between a line containing `applying patch:` and the next line
 * starting with `to:` become one `<patch omitted>` line (to the end when no `to:` follows); both bounds stay. Any
 * other line holding a `"data":` or `"stringData":` fragment becomes `<omitted>`, and the value after a last-applied
 * annotation key is cut to `<omitted>`.
 */
export function redactKubectlStderr(text: string): string {
  if (text === '') return text
  const out: string[] = []
  let inPatch = false
  for (const line of text.split('\n')) {
    if (inPatch) {
      if (!PATCH_END.test(line)) continue
      inPatch = false
      out.push(line)
      continue
    }
    if (line.includes(PATCH_START)) {
      out.push(line, PATCH_OMITTED)
      inPatch = true
      continue
    }
    // The annotation's value is cut first; what is left before it is checked like any other line.
    const at = line.indexOf(LAST_APPLIED)
    const end = at + LAST_APPLIED.length
    const kept = at < 0 ? line : `${line.slice(0, end)}${line[end] === '"' ? '"' : ''}: ${OMITTED}`
    out.push(SECRET_FIELD.test(kept) ? OMITTED : kept)
  }
  return out.join('\n')
}
