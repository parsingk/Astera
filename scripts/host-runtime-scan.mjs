// The package scan of scripts/host-runtime.mjs, apart so a test can run it over a fixture bundle.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { basename, dirname, join } from 'node:path'

/**
 * **Every package the Host bundle loads, read out of the bundle itself.**
 *
 * `externalizeDepsPlugin` leaves every dependency as a bare `require`, and the node.exe of the
 * runtime resolves those against the runtime's own directory, not against the app's asar. A missing
 * one is not a degraded Host: it is MODULE_NOT_FOUND on the first line, before the log file is even
 * open, and the app finds no Host at all.
 *
 * Read from the emitted files rather than listed by hand, for the same reason the runtime manifest
 * is walked rather than typed out: a hand-kept list goes stale the first time an import changes, and
 * nothing notices until a packaged build is installed. Only the chunks `entry` actually reaches are
 * scanned, because the chunks directory also holds the app's.
 *
 * Returns the bare, non-builtin names, sorted. Which of them to copy, and how, is the caller's.
 */
export function bundlePackages(entry) {
  const reachable = () => {
    const seen = new Set()
    const stack = [entry]
    while (stack.length > 0) {
      const file = stack.pop()
      if (seen.has(file)) continue
      seen.add(file)
      // Both quote styles here too. A single-quoted relative require the walk cannot see ends the
      // walk at host.js, the package scan below then reads one file, and a runtime ships without the
      // packages its chunks need: the failure this whole block exists to prevent, arrived by the
      // one path that looks like it is covered.
      for (const m of readFileSync(file, 'utf8').matchAll(/require\(\s*(?:"(\.[^"]*)"|'(\.[^']*)')\s*\)/g))
        stack.push(join(dirname(file), m[1] ?? m[2]))
    }
    return [...seen]
  }
  const packages = new Set()
  for (const file of reachable())
    // Both quote styles: which one the bundler emits is its own business, and a scan that sees only
    // one of them fails silently, because the package is simply never shipped. **And both ways of
    // loading**: a dynamic `import("…")` stays an import in the bundle, and src/host/sessions.ts loads
    // @xterm/headless that way. A scan of require() alone shipped a runtime without it, and
    // `astera sessions read` failed with ERR_MODULE_NOT_FOUND under node.exe (S2 final review, I2).
    // Only literal names count; an import of a computed name has nothing here to read.
    for (const m of readFileSync(file, 'utf8').matchAll(/(?:require|\bimport)\(\s*(?:"([^".][^"]*)"|'([^'.][^']*)')\s*\)/g)) {
      const name = m[1] ?? m[2]
      if (!isBuiltin(name)) packages.add(name)
    }
  return [...packages].sort()
}

const typeOnly = (name) => name.startsWith('@types/') || name === 'undici-types'

/** Where Node finds `name` when `fromDir` asks for it. */
function resolvePackage(root, name, fromDir) {
  for (let d = fromDir; ; d = dirname(d)) {
    if (basename(d) !== 'node_modules') {
      const c = join(d, 'node_modules', name)
      if (existsSync(join(c, 'package.json'))) return c
    }
    if (d === root || dirname(d) === d) return null
  }
}

/** A .node file anywhere in the package, its own nested node_modules left out (those are packages of their own). */
function hasNativeBinary(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && hasNativeBinary(join(dir, e.name))) return true
    } else if (e.name.endsWith('.node')) return true
  }
  return false
}

/** Every installed package directory `names` load at runtime, relative to `root` with forward slashes
 *  (`node_modules/p-queue/node_modules/eventemitter3`), sorted. Resolved as Node resolves: from the asking
 *  package's own directory up, skipping directories named node_modules, stopping at `root`. Dependencies
 *  and non-optional peers are required; optional ones count when installed. Type-only packages are left
 *  out (P14). Throws on a required package that is not installed, and on a native one not in allowNative. */
export function dependencyClosure(root, names, { allowNative = [] } = {}) {
  const found = new Map()
  const visit = (name, fromDir, required) => {
    if (typeOnly(name)) return
    const dir = resolvePackage(root, name, fromDir)
    if (!dir) {
      if (required) throw new Error(`${name} is required from ${fromDir}, and it is not installed — run npm install`)
      return
    }
    if (found.has(dir)) return
    const m = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    if (!allowNative.includes(name) && (existsSync(join(dir, 'binding.gyp')) || m.gypfile === true || hasNativeBinary(dir)))
      throw new Error(`${name} is a native module — the Host runtime ships node-pty's prebuild only`)
    found.set(dir, name)
    for (const n of Object.keys(m.dependencies ?? {})) visit(n, dir, true)
    for (const n of Object.keys(m.optionalDependencies ?? {})) visit(n, dir, false)
    const meta = m.peerDependenciesMeta ?? {}
    for (const n of Object.keys(m.peerDependencies ?? {})) visit(n, dir, meta[n]?.optional !== true)
  }
  for (const n of names) visit(n, root, true)
  return [...found.keys()].map((d) => d.slice(root.length + 1).split(/[\\/]/).join('/')).sort()
}
