// The plugin author's commands (Plugin Platform V2, Phase 2 step 4a, spec E4) answered in the CLI process, without a
// Host, like `skills` and `ext`: they read and write the author's own folder, never the profile. An agent session may run
// them; only installing into Astera stays the person's (`plugins install`).
//
//   validate  the folder checked as an install would (host/plugins/folderCheck.ts); exit 1 naming each problem
//   init      a new plugin folder from one of four templates (cli/pluginTemplates.ts)
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { CliError } from '../core/orchestration/cliOutput'
import { PLUGIN_SERVED_CAPABILITIES, parseManifest } from '../core/plugins/manifest'
import { checkPluginFolder, type FolderProblem } from '../host/plugins/folderCheck'
import { PLUGIN_TEMPLATES, pluginTemplate, type PluginTemplate } from './pluginTemplates'

type Outcome = { ok: true; body: Record<string, unknown> } | { ok: false; error: CliError }

const invalid = (message: string): Outcome => ({ ok: false, error: { code: 'INVALID_ARGUMENTS', message } })

/** One problem as a line: its code, the field it is about, the install's sentence. */
const lineOf = (p: FolderProblem): string => `${p.code}${p.field !== undefined ? ` ${p.field}` : ''}: ${p.message}`

export async function pluginDevCommand(a: { cmd: string; args: Record<string, unknown>; cwd: string; version: string }): Promise<Outcome> {
  if (a.cmd === 'plugins-validate') return validate(a)
  if (a.cmd === 'plugins-init') return init(a)
  return invalid(`${a.cmd} is not one of the plugin author's commands`)
}

async function validate(a: { args: Record<string, unknown>; cwd: string; version: string }): Promise<Outcome> {
  if (typeof a.args.path !== 'string' || a.args.path === '') return invalid('plugins validate needs --path <folder>')
  const folder = path.resolve(a.cwd, a.args.path)
  const r = await checkPluginFolder(folder, { version: a.version, capabilities: PLUGIN_SERVED_CAPABILITIES })
  if (r.problems.length === 1 && r.problems[0].code === 'NOT_A_FOLDER') return invalid(r.problems[0].message)
  const body = { valid: r.problems.length === 0, ...(r.plugin ? { plugin: r.plugin } : {}), problems: r.problems }
  if (body.valid) return { ok: true, body }
  return {
    ok: false,
    error: { code: 'FAILED', message: `${r.plugin?.id ?? folder} would not install: ${r.problems.map(lineOf).join('; ')}`, details: body }
  }
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
