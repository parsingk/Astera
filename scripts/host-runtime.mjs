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
  // Which directory to copy, read by the app from the directory rather than from a constant in its
  // own code — so the two can never disagree about which Node was shipped. It sits outside the
  // versioned tree because it is the thing that names the version.
  writeFileSync(join(OUT, 'runtime.json'), JSON.stringify({ node: NODE.version, app: appVersion }, null, 2) + '\n')

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

  // The whole chunks directory rather than the one file host.js names. It is ~11 KB, the names carry
  // build hashes, and which chunk belongs to which entry is a bundler detail this script has no
  // business parsing.
  const buildOut = join(tree, 'builds', appVersion)
  mkdirSync(buildOut, { recursive: true })
  cpSync(join(built, 'host.js'), join(buildOut, 'host.js'))
  if (existsSync(join(built, 'chunks'))) {
    cpSync(join(built, 'chunks'), join(buildOut, 'chunks'), { recursive: true })
  }

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
