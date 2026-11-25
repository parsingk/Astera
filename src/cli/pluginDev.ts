// The plugin author's commands (Plugin Platform V2, Phase 2 step 4a, spec E4) answered in the CLI process, without a
// Host, like `skills` and `ext`: they read and write the author's own folder, never the profile. An agent session may run
// them; only installing into Astera stays the person's (`plugins install`).
//
//   validate  the folder checked as an install would (host/plugins/folderCheck.ts); exit 1 naming each problem
//   init      a new plugin folder from one of four templates (cli/pluginTemplates.ts)
//   pack      a deterministic package of a folder that validates, with its checksums (host/plugins/pack.ts)
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CliError } from '../core/orchestration/cliOutput'
import { PLUGIN_SERVED_CAPABILITIES, parseManifest } from '../core/plugins/manifest'
import { checkPluginFolder, type FolderCheck, type FolderProblem } from '../host/plugins/folderCheck'
import { packFolder } from '../host/plugins/pack'
import { PLUGIN_TEMPLATES, pluginTemplate, type PluginTemplate } from './pluginTemplates'

type Outcome = { ok: true; body: Record<string, unknown> } | { ok: false; error: CliError }

const invalid = (message: string): Outcome => ({ ok: false, error: { code: 'INVALID_ARGUMENTS', message } })

/** One problem as a line: its code, the field it is about, the install's sentence. */
const lineOf = (p: FolderProblem): string => `${p.code}${p.field !== undefined ? ` ${p.field}` : ''}: ${p.message}`

export async function pluginDevCommand(a: { cmd: string; args: Record<string, unknown>; cwd: string; version: string }): Promise<Outcome> {
  if (a.cmd === 'plugins-validate') return validate(a)
  if (a.cmd === 'plugins-init') return init(a)
  if (a.cmd === 'plugins-pack') return pack(a)
  return invalid(`${a.cmd} is not one of the plugin author's commands`)
}

async function validate(a: { args: Record<string, unknown>; cwd: string; version: string }): Promise<Outcome> {
  if (typeof a.args.path !== 'string' || a.args.path === '') return invalid('plugins validate needs --path <folder>')
  const folder = path.resolve(a.cwd, a.args.path)
  const r = await checkPluginFolder(folder, { version: a.version, capabilities: PLUGIN_SERVED_CAPABILITIES })
  if (r.problems.length === 1 && r.problems[0].code === 'NOT_A_FOLDER') return invalid(r.problems[0].message)
  return r.problems.length === 0 ? { ok: true, body: validBody(r) } : refused(folder, r)
}

const validBody = (r: FolderCheck): Record<string, unknown> => ({ valid: r.problems.length === 0, ...(r.plugin ? { plugin: r.plugin } : {}), problems: r.problems })

/** A folder that would not install: FAILED (exit 1), each problem named, the problems in the details. */
const refused = (folder: string, r: FolderCheck): Outcome => ({
  ok: false,
  error: { code: 'FAILED', message: `${r.plugin?.id ?? folder} would not install: ${r.problems.map(lineOf).join('; ')}`, details: validBody(r) }
})

/** Whether `p` is `folder` or inside it, by their resolved paths, without regard to case on Windows. */
const within = (folder: string, p: string): boolean => {
  const rel = path.relative(folder, p)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

async function init(a: { args: Record<string, unknown>; cwd: string; version: string }): Promise<Outcome> {
  const name = a.args.name
  if (typeof name !== 'string' || name === '') return invalid('plugins init needs the plugin name: astera plugins init <name> --template <kind>')
  const kind = a.args.template
  if (typeof kind !== 'string' || !(PLUGIN_TEMPLATES as readonly string[]).includes(kind))
    return invalid('plugins init needs --template ui, host, check or source')
  const files = pluginTemplate(kind as PluginTemplate, name)
  // The name is the manifest's own: refused before anything is written, in the words an install would use
  const parsed = parseManifest(JSON.parse(files['package.json']))
  if (!parsed.ok) return invalid(parsed.problems.join('; '))
  const folder = path.resolve(a.cwd, name.split('/').pop() as string)
  const held = await fs.readdir(folder).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? [] : null))
  if (held === null) return invalid(`${folder} is not a folder Astera can write into`)
  if (held.length > 0) return { ok: false, error: { code: 'CONFLICT', message: `${folder} already holds files; nothing was written` } }
  for (const [rel, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(folder, rel)), { recursive: true })
    await fs.writeFile(path.join(folder, rel), body)
  }
  const check = await checkPluginFolder(folder, { version: a.version, capabilities: PLUGIN_SERVED_CAPABILITIES })
  return {
    ok: true,
    body: {
      folder,
      template: kind,
      files: Object.keys(files),
      ...(check.plugin ? { plugin: check.plugin } : {}),
      next: [`astera plugins validate --path ${folder}`, `astera plugins install --path ${folder}`]
    }
  }
}

async function pack(a: { args: Record<string, unknown>; cwd: string; version: string }): Promise<Outcome> {
  if (typeof a.args.path !== 'string' || a.args.path === '') return invalid('plugins pack needs --path <folder>')
  if (a.args.out !== undefined && (typeof a.args.out !== 'string' || a.args.out === '')) return invalid('plugins pack --out needs a file name')
  const folder = path.resolve(a.cwd, a.args.path)
  const chosen = typeof a.args.out === 'string' ? path.resolve(a.cwd, a.args.out) : undefined
  if (chosen !== undefined && within(folder, chosen)) return invalid(`${chosen} is inside the folder it packs; write the package elsewhere`)
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-plugin-pack-'))
  try {
    const r = await checkPluginFolder(folder, { version: a.version, capabilities: PLUGIN_SERVED_CAPABILITIES }, { keepCopy: path.join(work, 'plugin') })
    if (r.problems.length === 1 && r.problems[0].code === 'NOT_A_FOLDER') return invalid(r.problems[0].message)
    if (r.problems.length > 0 || r.copy === undefined || r.plugin === undefined) return refused(folder, r)
    // npm's own file name: a scope's @ dropped and its / a dash
    const file = chosen ?? path.join(path.dirname(folder), `${r.plugin.name.replace(/^@/, '').replace('/', '-')}-${r.plugin.version}.tgz`)
    if (within(folder, file)) return invalid(`${file} is inside the folder it packs; give --out`)
    const packed = await packFolder(r.copy)
    await fs.mkdir(path.dirname(file), { recursive: true })
    // Written beside, then put in place: a reader never sees half a package
    await fs.writeFile(`${file}.part`, packed.tgz)
    await fs.rename(`${file}.part`, file)
    return {
      ok: true,
      body: {
        file,
        plugin: r.plugin,
        bytes: packed.tgz.length,
        sha256: createHash('sha256').update(packed.tgz).digest('hex'),
        integrity: `sha512-${createHash('sha512').update(packed.tgz).digest('base64')}`,
        files: packed.files.length,
        leftOut: packed.leftOut
      }
    }
  } finally {
    await fs.rm(work, { recursive: true, force: true })
  }
}
