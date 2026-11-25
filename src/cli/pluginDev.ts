// The plugin author's commands (Plugin Platform V2, Phase 2 step 4a, spec E4) answered in the CLI process, without a
// Host, like `skills` and `ext`: they read and write the author's own folder, never the profile. An agent session may run
// them; only installing into Astera stays the person's (`plugins install`).
//
//   validate  the folder checked as an install would (host/plugins/folderCheck.ts); exit 1 naming each problem
//   init      a new plugin folder from one of four templates (cli/pluginTemplates.ts)
//   pack      a deterministic package of a folder that validates, with its checksums (host/plugins/pack.ts), read back
//             as `install --file` will read it before it is written where asked
//   test      the plugin run against Astera's contract in the real plugin runtime and a fake Host (cli/pluginTest.ts)
//
// A file system error is an answer (FAILED, exit 1), never a stack trace (plugin CLI final review I3).
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CliError } from '../core/orchestration/cliOutput'
import { PLUGIN_SERVED_CAPABILITIES, parseManifest } from '../core/plugins/manifest'
import { checkPluginFolder, type FolderCheck, type FolderProblem } from '../host/plugins/folderCheck'
import { moveRetrying } from '../host/plugins/moves'
import { packFolder } from '../host/plugins/pack'
import { PackageRefused, extractPackage } from '../host/plugins/tarball'
import { configureArgs } from './plugins'
import { PLUGIN_TEMPLATES, pluginTemplate, type PluginTemplate } from './pluginTemplates'
import { testPlugin } from './pluginTest'

type Outcome = { ok: true; body: Record<string, unknown> } | { ok: false; error: CliError }

const invalid = (message: string): Outcome => ({ ok: false, error: { code: 'INVALID_ARGUMENTS', message } })
const failed = (message: string): Outcome => ({ ok: false, error: { code: 'FAILED', message } })
const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** One problem as a line: its code, the field it is about, the install's sentence. */
const lineOf = (p: FolderProblem): string => `${p.code}${p.field !== undefined ? ` ${p.field}` : ''}: ${p.message}`

export async function pluginDevCommand(a: {
  cmd: string
  args: Record<string, unknown>
  cwd: string
  version: string
  /** The plugin launcher `test` runs a plugin with: plugin-host.js beside the CLI. */
  launcher?: string
}): Promise<Outcome> {
  try {
    if (a.cmd === 'plugins-validate') return await validate(a)
    if (a.cmd === 'plugins-init') return await init(a)
    if (a.cmd === 'plugins-pack') return await pack(a)
    if (a.cmd === 'plugins-test') return await test(a)
  } catch (e) {
    return failed(`${a.cmd.replace('-', ' ')} could not finish: ${reason(e)}`)
  }
  return invalid(`${a.cmd} is not one of the plugin author's commands`)
}

const host = (version: string) => ({ version, capabilities: PLUGIN_SERVED_CAPABILITIES })

/** What a check answers: valid, the plugin, its problems, and its warnings when it has any. */
const checkBody = (r: FolderCheck): Record<string, unknown> => ({
  valid: r.problems.length === 0,
  ...(r.plugin ? { plugin: r.plugin } : {}),
  problems: r.problems,
  ...(r.warnings.length > 0 ? { warnings: r.warnings } : {})
})

/** A folder that would not install: FAILED (exit 1), each problem named, the problems in the details. */
const refused = (folder: string, r: FolderCheck, how = 'would not install'): Outcome => ({
  ok: false,
  error: { code: 'FAILED', message: `${r.plugin?.id ?? folder} ${how}: ${r.problems.map(lineOf).join('; ')}`, details: checkBody(r) }
})

/** Whether `p` is `folder` or inside it, by their resolved paths, without regard to case on Windows. */
const within = (folder: string, p: string): boolean => {
  const rel = path.relative(folder, p)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

async function validate(a: { args: Record<string, unknown>; cwd: string; version: string }): Promise<Outcome> {
  if (typeof a.args.path !== 'string' || a.args.path === '') return invalid('plugins validate needs --path <folder>')
  const folder = path.resolve(a.cwd, a.args.path)
  const r = await checkPluginFolder(folder, host(a.version))
  if (r.problems.length === 1 && r.problems[0].code === 'NOT_A_FOLDER') return invalid(r.problems[0].message)
  return r.problems.length === 0 ? { ok: true, body: checkBody(r) } : refused(folder, r)
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
  const held = await fs.readdir(folder).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : undefined))
  if (held === undefined) return invalid(`${folder} is not a folder Astera can write into`)
  if (held !== null && held.length > 0) return { ok: false, error: { code: 'CONFLICT', message: `${folder} already holds files; nothing was written` } }
  try {
    for (const [rel, body] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(folder, rel)), { recursive: true })
      await fs.writeFile(path.join(folder, rel), body)
    }
  } catch (e) {
    // Half a plugin is no plugin: what was written goes, and a folder this made goes with it
    if (held === null) await fs.rm(folder, { recursive: true, force: true }).catch(() => {})
    else for (const rel of Object.keys(files)) await fs.rm(path.join(folder, rel.split('/')[0]), { recursive: true, force: true }).catch(() => {})
    return failed(`plugins init could not write ${folder}: ${reason(e)}`)
  }
  const check = await checkPluginFolder(folder, host(a.version))
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
  if (chosen !== undefined && (await fs.stat(chosen).then((s) => s.isDirectory(), () => false)))
    return invalid(`${chosen} is a folder; give the package's file name, such as ${path.join(chosen, 'plugin-1.0.0.tgz')}`)
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-plugin-pack-'))
  try {
    const r = await checkPluginFolder(folder, host(a.version), { keepCopy: path.join(work, 'plugin') })
    if (r.problems.length === 1 && r.problems[0].code === 'NOT_A_FOLDER') return invalid(r.problems[0].message)
    if (r.problems.length > 0 || r.copy === undefined || r.plugin === undefined) return refused(folder, r)
    // npm's own file name: a scope's @ dropped and its / a dash
    const file = chosen ?? path.join(path.dirname(folder), `${r.plugin.name.replace(/^@/, '').replace('/', '-')}-${r.plugin.version}.tgz`)
    if (within(folder, file)) return invalid(`${file} is inside the folder it packs; give --out`)
    const packed = await packFolder(r.copy)
    // install --file fetches nothing: a dependency the package does not carry would be missing when the plugin runs
    if (packed.unpacked.length > 0) {
      const one = packed.unpacked.length === 1
      const message = `${packed.unpacked.join(', ')} ${one ? 'is a dependency' : 'are dependencies'} the package would not carry: bundle the plugin into its entry, or list ${one ? 'it' : 'them'} in bundleDependencies`
      return refused(folder, { ...r, problems: [{ code: 'DEPENDENCIES_NOT_PACKED', message }] }, 'would not run from its package')
    }

    // Read back as `install --file` will read it (final review I1): the Host's extractor and its limits, then the entry
    // and ui in what came out, which the left-out rules could have taken away
    const staged = path.join(work, 'package.tgz')
    await fs.writeFile(staged, packed.tgz)
    const back = path.join(work, 'back')
    const problems: FolderProblem[] = []
    try {
      await extractPackage(staged, back)
    } catch (e) {
      if (!(e instanceof PackageRefused)) throw e
      problems.push({ code: 'PACKAGE_REFUSED', message: e.message })
    }
    if (problems.length === 0) {
      const there = (rel: string): Promise<boolean> => fs.stat(path.join(back, rel)).then((s) => s.isFile(), () => false)
      const named = await entryAndUi(r.copy)
      if (named.entry !== undefined && !(await there(named.entry)))
        problems.push({ code: 'ENTRY_MISSING', message: `the entry ${named.entry} is left out of the package: rename it` })
      if (named.ui !== undefined && !(await there(named.ui))) problems.push({ code: 'UI_MISSING', message: `the ui ${named.ui} is left out of the package: rename it` })
    }
    if (problems.length > 0) return refused(folder, { ...r, problems }, 'would not install from its package')

    try {
      await fs.mkdir(path.dirname(file), { recursive: true })
      // Written beside, then put in place: a reader never sees half a package
      await fs.copyFile(staged, `${file}.part`)
      await moveRetrying(`${file}.part`, file)
    } catch (e) {
      await fs.rm(`${file}.part`, { force: true }).catch(() => {})
      return failed(`plugins pack could not write ${file}: ${reason(e)}`)
    }
    // The top-level .git the copier never copies is left out too, and said so
    const git = await fs.stat(path.join(folder, '.git')).then(() => ['.git'], () => [])
    return {
      ok: true,
      body: {
        file,
        plugin: r.plugin,
        bytes: packed.tgz.length,
        sha256: createHash('sha256').update(packed.tgz).digest('hex'),
        integrity: `sha512-${createHash('sha512').update(packed.tgz).digest('base64')}`,
        files: packed.files.length,
        skipped: packed.skipped,
        leftOut: [...git, ...packed.leftOut].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)),
        ...(r.warnings.length > 0 ? { warnings: r.warnings } : {})
      }
    }
  } finally {
    await fs.rm(work, { recursive: true, force: true })
  }
}

/** The entry and ui the checked copy's manifest names. */
async function entryAndUi(copy: string): Promise<{ entry?: string; ui?: string }> {
  const parsed = parseManifest(JSON.parse(await fs.readFile(path.join(copy, 'package.json'), 'utf8')))
  return parsed.ok ? { entry: parsed.manifest.entry, ui: parsed.manifest.ui } : {}
}

async function test(a: { args: Record<string, unknown>; cwd: string; version: string; launcher?: string }): Promise<Outcome> {
  if (typeof a.args.path !== 'string' || a.args.path === '') return invalid('plugins test needs --path <folder>')
  const set = configureArgs({ set: a.args.set }, undefined)
  if ('error' in set) return invalid(set.error)
  const folder = path.resolve(a.cwd, a.args.path)
  const r = await testPlugin({ folder, version: a.version, launcher: a.launcher ?? '', settings: set.args.set as Record<string, string> })
  if ('problems' in r) {
    if (r.problems.length === 1 && r.problems[0].code === 'NOT_A_FOLDER') return invalid(r.problems[0].message)
    return refused(folder, { problems: r.problems, warnings: [] })
  }
  const body = { plugin: r.plugin, ok: r.ok, checks: r.checks, ...(r.warnings ? { warnings: r.warnings } : {}) }
  if (r.ok) return { ok: true, body }
  const failing = r.checks.filter((c) => !c.ok)
  return { ok: false, error: { code: 'FAILED', message: `${r.plugin.id} failed a check: ${failing.map((c) => `${c.name}: ${c.detail}`).join('; ')}`, details: body } }
}

