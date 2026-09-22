#!/usr/bin/env node
// Assembles resources/host-runtime/ — the Host's own executable, shipped inside the Windows
// installer (docs/superpowers/specs/2026-09-14-host-runtime-design.md §6).
//
// Why the Host needs one: it is spawned from `process.execPath`, the app's own Astera.exe run with
// ELECTRON_RUN_AS_NODE, and Windows locks the image of a running process. A Host that outlives the
// app therefore pins the install directory and no installer can write over it. Give it an executable
// that lives somewhere else and the installer has nothing to fight — and a Windows session survives
// an update the way it already does on macOS and Linux.
//
// Runs between `electron-vite build` and `electron-builder --win`: it needs out/main/host.js, and
// electron-builder needs its output.
//
//   node scripts/host-runtime.mjs            # skips unless building for Windows
//   node scripts/host-runtime.mjs --force    # assemble anyway (inspecting the payload elsewhere)
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'resources', 'host-runtime')
/**
 * **The shipped tree is laid out exactly like the installed one**, `node-<version>` and all, so the
 * app installs it with a single directory copy. That nesting is not cosmetic: electron-builder's
 * file filter drops a directory named exactly `node_modules` at the root of anything it copies —
 * `createFilter` in app-builder-lib/out/util/filter.js returns false for it before any pattern is
 * consulted, so no `files` entry can bring it back, and a flat layout shipped node-pty-less. One
 * level of nesting puts it at `<dir>/node_modules`, which that same filter keeps.
 */
const nodeDirName = (version) => `node-${version}`
const CACHE = join(ROOT, 'build', '.cache')

/**
 * **Pinned to the Node that Electron itself bundles.** Measured, rather than chosen:
 *
 *     ELECTRON_RUN_AS_NODE=1 electron.exe -e "process.versions.node"   ->  24.15.0
 *
 * So the Host has been running on this Node major in every release since the Host existed. Matching
 * it means the runtime path and the fallback path (`resolveHostExec`, src/main/ipc.ts) put the same
 * code on the same Node, instead of the Host quietly behaving one way when the runtime is present and
 * another when it is not. Move this when Electron's bundled Node moves, so the two stay together.
 *
 * The hashes are the trust anchor and are checked against the bytes we actually got. They are pinned
 * here rather than read from the release's own SHASUMS256.txt, which arrives over the same channel as
 * the file and so proves nothing about it.
 */
const NODE = {
  version: '24.15.0',
  exe: {
    url: 'https://nodejs.org/dist/v24.15.0/win-x64/node.exe',
    sha256: '3331e1ffe19874215472217c5e94f5a0c6d8e18c4ac7111d3937aa0ad5e9b4a5',
    cache: 'node-24.15.0-win-x64.exe'
  },
  // Node is MIT, and its binary vendors OpenSSL, ICU, zlib and more — this one file is the licence
  // for all of it. Shipped for the same reason LICENSE.electron.txt and resources/font-licenses are.
  license: {
    url: 'https://raw.githubusercontent.com/nodejs/node/v24.15.0/LICENSE',
    sha256: '4573185d56580da2b890ba34a85a409257640f1c5632eade4300137266194d18',
    cache: 'node-24.15.0-LICENSE.txt'
  }
}

const force = process.argv.includes('--force')
if (process.platform !== 'win32' && !force) {
  // Only win.extraResources consumes this, so assembling it during a mac or Linux build would
  // download 87 MB to package nothing. Not an error: `npm run dist` is expected to run this.
  console.log('host-runtime: not building for Windows — skipped (--force to assemble anyway)')
  process.exit(0)
}

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`

/** Downloads once and keeps it under build/.cache, so a rebuild does not refetch 87 MB. The hash is
 *  verified on the cached copy too — a truncated download must not survive as a "cache hit". */
async function fetchPinned({ url, sha256, cache }) {
  const cached = join(CACHE, cache)
  if (existsSync(cached)) {
    const have = createHash('sha256').update(readFileSync(cached)).digest('hex')
    if (have === sha256) return readFileSync(cached)
    console.log(`host-runtime: cached ${cache} does not match its pin — refetching`)
    rmSync(cached, { force: true })
  }
  console.log(`host-runtime: fetching ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} answered ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const have = createHash('sha256').update(buf).digest('hex')
  if (have !== sha256) {
    throw new Error(`${url} does not match its pinned hash.\n  expected ${sha256}\n  got      ${have}`)
  }
  mkdirSync(CACHE, { recursive: true })
  writeFileSync(cached, buf)
  return buf
}

async function main() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const appVersion = pkg.version

  // The build output this wraps. Failing here rather than shipping a runtime with no entry: a Host
  // that cannot start is worse than one that was never installed, because the app would keep trying.
  const built = join(ROOT, 'out', 'main')
  if (!existsSync(join(built, 'host.js'))) {
    throw new Error('out/main/host.js is missing — run `electron-vite build` before this script')
  }

  // node-pty ships its native binaries as prebuilds keyed by platform and architecture alone, with no
  // Node-ABI directory, because it is built on node-addon-api (N-API). That is what makes this whole
  // design a copy rather than a second native build: the same pty.node loads under Electron and under
  // stock Node.
  const pty = join(ROOT, 'node_modules', 'node-pty')
  const prebuild = join(pty, 'prebuilds', 'win32-x64')
  if (!existsSync(join(prebuild, 'pty.node'))) {
    throw new Error(`node-pty has no win32-x64 prebuild at ${prebuild} — run npm install`)
  }

  const [exe, license] = await Promise.all([fetchPinned(NODE.exe), fetchPinned(NODE.license)])

  rmSync(OUT, { recursive: true, force: true })
  const tree = join(OUT, nodeDirName(NODE.version))
  mkdirSync(tree, { recursive: true })

  writeFileSync(join(tree, 'node.exe'), exe)
  writeFileSync(join(tree, 'LICENSE.node.txt'), license)

  // package.json is required: node-pty's own entry point is read from it. lib/ is the JavaScript,
  // prebuilds/win32-x64 the native half. The .pdb files are debug symbols for someone else's build —
  // 28 MB of them — and nothing loads them.
  const ptyOut = join(tree, 'node_modules', 'node-pty')
  mkdirSync(ptyOut, { recursive: true })
  cpSync(join(pty, 'package.json'), join(ptyOut, 'package.json'))
  cpSync(join(pty, 'lib'), join(ptyOut, 'lib'), { recursive: true })
  cpSync(prebuild, join(ptyOut, 'prebuilds', 'win32-x64'), {
    recursive: true,
    filter: (src) => !src.endsWith('.pdb')
  })

  // **Every other package the Host bundle requires, read out of the bundle itself.**
  //
  // node-pty above used to be the whole list. The Host runs the orchestration command layer now, and
  // that reaches `ignore` through core/files/tree.ts — `externalizeDepsPlugin` leaves every dependency
  // as a bare `require`, and the node.exe beside this tree resolves those against *this* directory,
  // not against the app's asar. A missing one is not a degraded Host: it is MODULE_NOT_FOUND on the
  // first line, before the log file is even open, and the app finds no Host at all.
  //
  // Read from the emitted files rather than listed here, for the same reason the manifest below is
  // walked rather than typed out: a hand-kept list goes stale the first time an import changes, and
  // nothing notices until a packaged build is installed. Only the chunks host.js actually reaches are
  // scanned — the copy below takes the whole chunks directory, and some of it belongs to the app.
  const reachable = (entry) => {
    const seen = new Set()
    const stack = [entry]
    while (stack.length > 0) {
      const file = stack.pop()
      if (seen.has(file)) continue
      seen.add(file)
      // Both quote styles here too. A single-quoted relative require the walk cannot see ends the
      // walk at host.js, the package scan below then reads one file, and a runtime ships without the
      // packages its chunks need — the failure this whole block exists to prevent, arrived by the
      // one path that looks like it is covered.
      for (const m of readFileSync(file, 'utf8').matchAll(/require\(\s*(?:"(\.[^"]*)"|'(\.[^']*)')\s*\)/g))
        stack.push(join(dirname(file), m[1] ?? m[2]))
    }
    return [...seen]
  }
  const packages = new Set()
  for (const file of reachable(join(built, 'host.js')))
    // Both quote styles: which one the bundler emits is its own business, and a scan that sees only
    // one of them fails silently — the package is simply never shipped.
    for (const m of readFileSync(file, 'utf8').matchAll(/require\(\s*(?:"([^".][^"]*)"|'([^'.][^']*)')\s*\)/g)) {
      const name = m[1] ?? m[2]
      if (!isBuiltin(name) && name !== 'node-pty') packages.add(name)
    }
  for (const name of [...packages].sort()) {
    const from = join(ROOT, 'node_modules', name)
    if (!existsSync(from)) throw new Error(`the Host bundle requires ${name}, which is not installed — run npm install`)
    // One level deep on purpose. A package with dependencies of its own needs a real resolver, and a
    // half-copied tree would fail the same way the missing package does — loudly here is the place to
    // find that out, not on a user's machine. **All three kinds count**: an optional or peer
    // dependency that the package actually requires at runtime is not optional to the Host, and
    // reading only `dependencies` lets exactly that one through the gate.
    const manifest = JSON.parse(readFileSync(join(from, 'package.json'), 'utf8'))
    const nested = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {})
    ]
    if (nested.length > 0)
      throw new Error(`the Host bundle requires ${name}, which depends on ${nested.join(', ')} — this script copies one level only`)
    cpSync(from, join(tree, 'node_modules', name), { recursive: true })
    console.log(`host-runtime: the Host bundle requires ${name} — shipped`)
  }

  // The whole chunks directory rather than the one file host.js names. It is ~11 KB, the names carry
  // build hashes, and which chunk belongs to which entry is a bundler detail this script has no
  // business parsing.
  const buildOut = join(tree, 'builds', appVersion)
  mkdirSync(buildOut, { recursive: true })
  cpSync(join(built, 'host.js'), join(buildOut, 'host.js'))
  if (existsSync(join(built, 'chunks'))) {
    cpSync(join(built, 'chunks'), join(buildOut, 'chunks'), { recursive: true })
  }

  /** Every file under `dir`, relative to it, with the separator the app compares against. */
  const filesUnder = (dir, prefix = '') => {
    const out = []
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}\\${e.name}` : e.name
      if (e.isDirectory()) out.push(...filesUnder(join(dir, e.name), rel))
      else out.push(rel)
    }
    return out.sort()
  }

  // Which directory to copy, and what a whole copy of it contains. Both read by the app from the
  // directory rather than from a constant in its own code — so the two can never disagree about what
  // was shipped. It sits outside the versioned tree because it is the thing that names the version.
  //
  // **The file list is walked from what was actually written, never typed out here.** A hand-kept
  // list is one that goes stale the first time this script copies something new, and a list that is
  // missing an entry is a runtime the app will call whole while the Host cannot spawn from it — which
  // is the exact failure this exists to catch (2026-09-22). The two halves are listed apart because
  // they go missing for different reasons: see `RuntimeFiles` in src/main/host/runtime.ts.
  writeFileSync(
    join(OUT, 'runtime.json'),
    JSON.stringify(
      {
        node: NODE.version,
        app: appVersion,
        files: {
          node: filesUnder(tree).filter((f) => !f.startsWith('builds\\')),
          build: filesUnder(buildOut)
        }
      },
      null,
      2
    ) + '\n'
  )

  const total = (dir) => {
    let n = 0
    const walk = (p) => {
      const s = statSync(p)
      if (!s.isDirectory()) return void (n += s.size)
      for (const e of readdirSync(p)) walk(join(p, e))
    }
    walk(dir)
    return n
  }
  console.log(
    `host-runtime: node ${NODE.version} + node-pty + build ${appVersion} -> resources/host-runtime/${nodeDirName(NODE.version)} (${mb(total(OUT))})`
  )
}

main().catch((err) => {
  console.error(`host-runtime: ${err.message}`)
  process.exit(1)
})
