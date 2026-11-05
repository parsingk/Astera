// Patching a provider's own settings file (Agent Control Plane release 1 design §4.2): read, parse, apply one change,
// keep the old text in `.bak`, write through a temp file, and parse what was written before trusting it. Codex's TOML
// goes through @decimalturn/toml-patch, which edits the source text in place, so comments, order and tables Astera
// does not know stay as the person left them. A file that cannot be parsed is refused, never overwritten.
import { promises as fs } from 'node:fs'
import { parse as parseToml, patch as patchToml, stringify as stringifyToml } from '@decimalturn/toml-patch'
import { oneAtATime, writeTarget, writeThroughTmp } from '../accounts/fileQueue'

type ConfigObject = Record<string, unknown>
type Patch = (current: ConfigObject) => ConfigObject | null

/** The TOML text as a plain object; throws on text that is not TOML. */
export function readTomlObject(text: string): ConfigObject {
  return parseToml(text) as ConfigObject
}

/** Equal by value: the TOML parser's objects have no prototype, so a structural compare would call a copy different. */
const valueText = (v: ConfigObject): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? `${x}n` : x))
const sameValue = (a: ConfigObject, b: ConfigObject): boolean => valueText(a) === valueText(b)

const readText = async (file: string): Promise<string | null> => {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

async function patchFile(
  file: string,
  patch: Patch,
  format: { parse(text: string): ConfigObject; render(before: string | null, next: ConfigObject): string },
  o: { throughLink?: boolean } = {}
): Promise<'written' | 'unchanged'> {
  let result: 'written' | 'unchanged' = 'unchanged'
  // The queue is keyed by the path given, not by what a link points to, so every write that names this path (Codex trust
  // marks among them) takes its turn in one line.
  await oneAtATime(file, async () => {
    // A link is written through so it stays a link; one that points nowhere is not written at all, and that is a failure,
    // not 'unchanged': a caller told 'unchanged' would take the file for in line. The `.bak` stays beside the path given.
    const target = o.throughLink ? await writeTarget(file) : file
    if (target === null) throw new Error(`${file} is a link that points nowhere, or cannot be looked at, so it was not written`)
    const before = await readText(target)
    const current = before === null || before.trim() === '' ? {} : format.parse(before)
    const next = patch(current)
    if (next === null || sameValue(next, current)) return
    const text = format.render(before, next)
    format.parse(text) // a write that would not read back is not made
    if (before !== null) await fs.writeFile(`${file}.bak`, before, 'utf8')
    await writeThroughTmp(target, text)
    result = 'written'
  })
  return result
}

/** Patches Codex's `config.toml` (or any TOML file) in place. With `throughLink` a file that is a symbolic link is read
 *  and written where the link points, as Codex does (a dotfile manager's link stays a link); a link that points nowhere,
 *  or that cannot be looked at, is left alone and the call rejects. */
export function patchTomlFile(file: string, patch: Patch, o?: { throughLink?: boolean }): Promise<'written' | 'unchanged'> {
  return patchFile(
    file,
    patch,
    {
      parse: readTomlObject,
      render: (before, next) => (before === null || before.trim() === '' ? stringifyToml(next) : patchToml(before, next))
    },
    o
  )
}

/** Patches a JSON settings file, keeping its indentation and final newline. */
export function patchJsonFile(file: string, patch: Patch): Promise<'written' | 'unchanged'> {
  return patchFile(file, patch, {
    parse: (text) => {
      const v: unknown = JSON.parse(text)
      if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${file} is not a JSON object`)
      return v as ConfigObject
    },
    render: (before, next) => {
      const indent = before?.match(/\n([ \t]+)"/)?.[1] ?? '  '
      return JSON.stringify(next, null, indent) + (before === null || before.endsWith('\n') ? '\n' : '')
    }
  })
}
