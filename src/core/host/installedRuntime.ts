// The Host runtime an Astera already laid down on this machine (runtime.ts names its places), found by looking: what runs
// Enforce's hook on Windows when the capture scripts were left a bare `node` (a development build, or a packaged one
// whose runtime could not be put in place). Any runtime there is Node's own node.exe under Astera's name, and the hook
// needs nothing else of it.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { HOST_EXE, NODE_PREFIX } from './runtime'

const RUNTIME_DIR = new RegExp(`^${NODE_PREFIX}(\\d+)\\.(\\d+)\\.(\\d+)-astera-host$`)

/** The executable of the newest runtime under `base` (its Node version), one whose executable is there; null for none,
 *  or no `base`. Never rejects. */
export async function findInstalledHostExe(base: string | null): Promise<string | null> {
  if (base === null) return null
  let names: string[]
  try {
    names = await fs.readdir(base)
  } catch {
    return null
  }
  const versions = names
    .map((name) => ({ name, m: RUNTIME_DIR.exec(name) }))
    .filter((x): x is { name: string; m: RegExpExecArray } => x.m !== null)
    .map(({ name, m }) => ({ name, v: [Number(m[1]), Number(m[2]), Number(m[3])] }))
    .sort((a, b) => b.v[0] - a.v[0] || b.v[1] - a.v[1] || b.v[2] - a.v[2])
  for (const { name } of versions) {
    const exe = path.join(base, name, HOST_EXE)
    try {
      if ((await fs.stat(exe)).isFile()) return exe
    } catch {
      // still being laid down, or swept: the next one
    }
  }
  return null
}
