// Copies a plugin's folder into the profile (plugin runtime design P7). The copy holds plain files and folders only: a
// link that stays inside the plugin is followed and what it leads to is copied (Windows cannot recreate a file link
// without a privilege), and a link that leads outside, leads nowhere or loops refuses the install, so what is installed
// is the folder the person approved and nothing it points at.
import { promises as fs } from 'node:fs'
import path from 'node:path'

export class PluginCopyRefused extends Error {
  readonly code = 'PLUGIN_COPY_REFUSED'
}

/** `b` is `a` or inside it. */
const within = (a: string, b: string): boolean => {
  const r = path.relative(a, b)
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r))
}

/** Dependency layouts that find a package through the real path of a link (final review I2). Node resolves a
 *  dependency from where a file really is, and a copy that turns links into folders moves it away from its siblings. */
const LINKED_LAYOUTS: readonly { folder: string; what: string; instead: string }[] = [
  { folder: '.pnpm', what: "pnpm's isolated layout", instead: 'install its dependencies hoisted (node-linker=hoisted)' },
  { folder: '.store', what: "npm's linked install strategy", instead: 'install its dependencies without --install-strategy=linked' }
]

/** Why a copy of this folder could not run, or null. */
export async function layoutProblem(src: string): Promise<string | null> {
  for (const l of LINKED_LAYOUTS) {
    const there = await fs.lstat(path.join(src, 'node_modules', l.folder)).then(() => true, () => false)
    if (there) return `node_modules/${l.folder} is ${l.what}, which a copy cannot keep: bundle the plugin, or ${l.instead}`
  }
  return null
}

/** Where a path that may not exist yet really is: its nearest existing folder resolved through any link, with the rest
 *  of the path after it (final review m8: a profile reached through a link is still inside a folder that holds it). */
async function realOf(p: string): Promise<string> {
  const rest: string[] = []
  let at = p
  for (;;) {
    try {
      return path.join(await fs.realpath(at), ...rest.reverse())
    } catch {
      const up = path.dirname(at)
      if (up === at) return p
      rest.push(path.basename(at))
      at = up
    }
  }
}

export async function copyPluginFolder(src: string, dest: string): Promise<void> {
  const layout = await layoutProblem(src)
  if (layout !== null) throw new PluginCopyRefused(layout)
  const root = await fs.realpath(src)
  const target = path.resolve(dest)
  if (within(path.resolve(src), target) || within(root, target) || within(root, await realOf(target)))
    throw new PluginCopyRefused(`${dest} is inside the folder it copies`)
  await fs.mkdir(target, { recursive: true })
  await copyInto(root, [root], target, '', true)
}

/** Walks `src` by copyPluginFolder's own rules and copies nothing: throws PluginCopyRefused where a copy would. What
 *  `plugins validate` asks, so a large node_modules is not copied on every check (plugin CLI final review m13). */
export async function checkPluginTree(src: string): Promise<void> {
  const layout = await layoutProblem(src)
  if (layout !== null) throw new PluginCopyRefused(layout)
  const root = await fs.realpath(src)
  await copyInto(root, [root], root, '', false)
}

/** Copies the folder at the end of `chain` into `to`. `chain` is the real path of every folder the walk is inside, from
 *  the root down, so a link back to any of them is a loop however many links it took to get there. `rel` is the path
 *  from the plugin's root, with `/`, for messages. */
async function copyInto(root: string, chain: readonly string[], to: string, rel: string, write: boolean): Promise<void> {
  const from = chain[chain.length - 1]
  for (const e of await fs.readdir(from, { withFileTypes: true })) {
    // Git's own folder at the top is history, not the plugin; a dependency's deeper down is whatever it shipped.
    if (rel === '' && e.name === '.git') continue
    const at = rel === '' ? e.name : `${rel}/${e.name}`
    const full = path.join(from, e.name)
    const into = path.join(to, e.name)
    if (e.isSymbolicLink()) {
      let real: string
      try {
        real = await fs.realpath(full)
      } catch {
        throw new PluginCopyRefused(`${at} is a link to something that is not there`)
      }
      if (!within(root, real))
        throw new PluginCopyRefused(`${at} is a link that leads outside the plugin; bundle it or replace the link with a copy`)
      const st = await fs.stat(real)
      if (st.isDirectory()) {
        // Following a link to a folder this one sits in would copy forever.
        if (chain.some((c) => within(real, c))) throw new PluginCopyRefused(`${at} is a link back to a folder it sits in`)
        if (write) await fs.mkdir(into)
        await copyInto(root, [...chain, real], into, at, write)
      } else if (st.isFile()) {
        if (write) await fs.copyFile(real, into)
      } else throw new PluginCopyRefused(`${at} is not a file or a folder`)
    } else if (e.isDirectory()) {
      if (write) await fs.mkdir(into)
      await copyInto(root, [...chain, full], into, at, write)
    } else if (e.isFile()) {
      if (write) await fs.copyFile(full, into)
    } else throw new PluginCopyRefused(`${at} is not a file or a folder`)
  }
}
