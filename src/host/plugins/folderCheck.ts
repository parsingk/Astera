// A plugin folder checked the way an install checks it (Plugin Platform V2, Phase 2 step 4a, spec E4 validate), every
// problem named by a code a program can read, the manifest field it is about, and the install's own sentence. Used by
// `astera plugins validate`, which answers it, and `astera plugins pack`, which archives the copy it checked.
//
// The checks are the install's: the manifest (core/plugins/manifest.ts), this Astera's compatibility, then a copy made
// with the install's own copier (copyFolder.ts: linked layouts, links that leave the folder), and the entry and ui as
// files in that copy. Only what an install would refuse is a problem.
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { incompatibility, parseManifest, type PluginManifest } from '../../core/plugins/manifest'
import { PluginCopyRefused, copyPluginFolder, layoutProblem } from './copyFolder'
import { readPackage } from './packageFile'

export type FolderProblemCode =
  | 'NOT_A_FOLDER'
  | 'MANIFEST_UNREADABLE'
  | 'MANIFEST_INVALID'
  | 'INCOMPATIBLE'
  | 'LAYOUT_REFUSED'
  | 'LINK_REFUSED'
  | 'ENTRY_MISSING'
  | 'UI_MISSING'

export interface FolderProblem {
  code: FolderProblemCode
  /** The manifest field a MANIFEST_INVALID problem is about, when its sentence names one. */
  field?: string
  message: string
}

export interface FolderCheck {
  /** The plugin the folder holds, once its manifest reads. */
  plugin?: { id: string; name: string; version: string; trust: PluginManifest['trust'] }
  problems: FolderProblem[]
  /** Where the checked copy was kept (opts.keepCopy), when it was made and kept. */
  copy?: string
}

/** The manifest field a parseManifest sentence starts with: `astera.contributes.commands: ...`, `version "x" ...`. */
const FIELD = /^(astera(?:\.[A-Za-z]+)*|name|version|displayName|description|engines\.astera)\b/

const problemOf = (code: FolderProblemCode, message: string): FolderProblem => ({ code, message })

/** Checks `folder` as an install would for an Astera at `host`. With `keepCopy`, the copy it checked is made there and
 *  kept (pack archives it); otherwise it is made in a temporary folder and removed. */
export async function checkPluginFolder(
  folder: string,
  host: { version: string; capabilities: readonly string[] },
  opts: { keepCopy?: string } = {}
): Promise<FolderCheck> {
  const isFolder = await fs.stat(folder).then((s) => s.isDirectory(), () => false)
  if (!isFolder) return { problems: [problemOf('NOT_A_FOLDER', `${folder} is not a folder`)] }

  const pkg = await readPackage(folder)
  if (!pkg.ok) return { problems: [problemOf('MANIFEST_UNREADABLE', pkg.error)] }
  const parsed = parseManifest(pkg.pkg)
  if (!parsed.ok) {
    return {
      problems: parsed.problems.map((message) => {
        const field = FIELD.exec(message)?.[1]
        return { code: 'MANIFEST_INVALID', ...(field !== undefined ? { field } : {}), message }
      })
    }
  }
  const m = parsed.manifest
  const plugin = { id: m.id, name: m.name, version: m.version, trust: m.trust }
  const problems: FolderProblem[] = []
  const incompatible = incompatibility(m, host)
  if (incompatible !== null) problems.push(problemOf('INCOMPATIBLE', incompatible))

  const layout = await layoutProblem(folder)
  if (layout !== null) return { plugin, problems: [...problems, problemOf('LAYOUT_REFUSED', layout)] }

  const temporary = opts.keepCopy === undefined ? await fs.mkdtemp(path.join(os.tmpdir(), 'astera-plugin-check-')) : null
  const copy = opts.keepCopy ?? path.join(temporary as string, 'plugin')
  let copied = false
  try {
    try {
      await copyPluginFolder(folder, copy)
      copied = true
    } catch (e) {
      if (!(e instanceof PluginCopyRefused)) throw e
      problems.push(problemOf('LINK_REFUSED', e.message))
    }
    if (copied) {
      const isFile = (rel: string): Promise<boolean> => fs.stat(path.join(copy, rel)).then((s) => s.isFile(), () => false)
      if (m.entry !== undefined && !(await isFile(m.entry))) problems.push(problemOf('ENTRY_MISSING', `the entry ${m.entry} is not a file in the plugin`))
      if (m.ui !== undefined && !(await isFile(m.ui))) problems.push(problemOf('UI_MISSING', `the ui ${m.ui} is not a file in the plugin`))
    }
  } finally {
    if (temporary !== null) await fs.rm(temporary, { recursive: true, force: true })
  }
  return { plugin, problems, ...(opts.keepCopy !== undefined && copied ? { copy: opts.keepCopy } : {}) }
}
