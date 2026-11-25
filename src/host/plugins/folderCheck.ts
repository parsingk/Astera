// A plugin folder checked the way an install checks it (Plugin Platform V2, Phase 2 step 4a, spec E4 validate), every
// problem named by a code a program can read, the manifest field it is about, and the install's own sentence. Used by
// `astera plugins validate`, which answers it, and `astera plugins pack`, which archives the copy it checked.
//
// The checks are the install's: the manifest (core/plugins/manifest.ts), the install's own copier (copyFolder.ts: linked
// layouts, links that leave the folder, what is not a file or a folder), walked without copying unless a copy is kept,
// and the entry and ui as files. Only what an install would refuse is a problem; that this Astera would not run it, which
// an install still takes and says, is a warning.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { incompatibility, parseManifest, type PluginManifest } from '../../core/plugins/manifest'
import { PluginCopyRefused, checkPluginTree, copyPluginFolder, layoutProblem } from './copyFolder'
import { readPackage } from './packageFile'

export type FolderProblemCode =
  | 'NOT_A_FOLDER'
  | 'MANIFEST_UNREADABLE'
  | 'MANIFEST_INVALID'
  | 'INCOMPATIBLE'
  | 'LAYOUT_REFUSED'
  | 'COPY_REFUSED'
  | 'ENTRY_MISSING'
  | 'UI_MISSING'
  /** `plugins pack` only: the package it made would be refused by `install --file` (tarball.ts's limits and names). */
  | 'PACKAGE_REFUSED'
  /** `plugins pack` only: a dependency the package would not carry, which `install --file` would not fetch. */
  | 'DEPENDENCIES_NOT_PACKED'

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
  /** What an install takes but this Astera would not run: INCOMPATIBLE. */
  warnings: FolderProblem[]
  /** Where the checked copy was kept (opts.keepCopy), when it was made and kept. */
  copy?: string
}

/** The manifest field a parseManifest sentence starts with: `astera.contributes.commands: ...`, `version "x" ...`. */
const FIELD = /^(astera(?:\.[A-Za-z0-9_]+)*|name|version|displayName|description|engines\.astera)\b/

const problemOf = (code: FolderProblemCode, message: string): FolderProblem => ({ code, message })

/** Checks `folder` as an install would for an Astera at `host`. With `keepCopy`, the copy is made there and checked and
 *  kept (pack archives it); otherwise the folder is walked by the copier's rules and nothing is copied. */
export async function checkPluginFolder(
  folder: string,
  host: { version: string; capabilities: readonly string[] },
  opts: { keepCopy?: string } = {}
): Promise<FolderCheck> {
  const isFolder = await fs.stat(folder).then((s) => s.isDirectory(), () => false)
  if (!isFolder) return { problems: [problemOf('NOT_A_FOLDER', `${folder} is not a folder`)], warnings: [] }

  const pkg = await readPackage(folder)
  if (!pkg.ok) return { problems: [problemOf('MANIFEST_UNREADABLE', pkg.error)], warnings: [] }
  const parsed = parseManifest(pkg.pkg)
  if (!parsed.ok) {
    return {
      problems: parsed.problems.map((message) => {
        const field = FIELD.exec(message)?.[1]
        return { code: 'MANIFEST_INVALID', ...(field !== undefined ? { field } : {}), message }
      }),
      warnings: []
    }
  }
  const m = parsed.manifest
  const plugin = { id: m.id, name: m.name, version: m.version, trust: m.trust }
  const problems: FolderProblem[] = []
  const incompatible = incompatibility(m, host)
  const warnings = incompatible !== null ? [problemOf('INCOMPATIBLE', incompatible)] : []

  const layout = await layoutProblem(folder)
  if (layout !== null) return { plugin, problems: [problemOf('LAYOUT_REFUSED', layout)], warnings }

  // The copy that will be packed, or, for a check alone, the folder walked by the copier's rules
  const at = opts.keepCopy ?? folder
  let walked = false
  try {
    if (opts.keepCopy !== undefined) await copyPluginFolder(folder, opts.keepCopy)
    else await checkPluginTree(folder)
    walked = true
  } catch (e) {
    if (!(e instanceof PluginCopyRefused)) throw e
    problems.push(problemOf('COPY_REFUSED', e.message))
  }
  if (walked) {
    const isFile = (rel: string): Promise<boolean> => fs.stat(path.join(at, rel)).then((s) => s.isFile(), () => false)
    if (m.entry !== undefined && !(await isFile(m.entry))) problems.push(problemOf('ENTRY_MISSING', `the entry ${m.entry} is not a file in the plugin`))
    if (m.ui !== undefined && !(await isFile(m.ui))) problems.push(problemOf('UI_MISSING', `the ui ${m.ui} is not a file in the plugin`))
  }
  return { plugin, problems, warnings, ...(opts.keepCopy !== undefined && walked ? { copy: opts.keepCopy } : {}) }
}
