// The package scan of scripts/host-runtime.mjs, apart so a test can run it over a fixture bundle.
import { readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { dirname, join } from 'node:path'

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
