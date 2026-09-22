import { describe, it, expect } from 'vitest'
import {
  prepareHostRuntime,
  staleBuildDirs,
  staleNodeDirs,
  sweepHostRuntime,
  type RuntimeFs
} from './runtime'
import { hostRuntimePaths } from '../../core/host/runtime'

/** A filesystem as a set of absolute paths, where a directory is anything that is a prefix of
 *  something. Enough to answer the only three questions this module asks — does it exist, copy it,
 *  make it not exist — and it keeps the sequencing (stage, rename, sweep) visible in one place.
 *
 *  The prefix test is `p === dir || p.startsWith(dir + '\\')` rather than a bare `startsWith`, so
 *  `node-1` never matches `node-10`. */
class FakeFs implements RuntimeFs {
  paths = new Set<string>()
  /** Operations to make throw, as `${op}:${path}`. */
  throwOn = new Set<string>()
  log: string[] = []

  private under(p: string, dir: string): boolean {
    return p === dir || p.startsWith(dir + '\\')
  }

  add(...ps: string[]): this {
    for (const p of ps) this.paths.add(p)
    return this
  }

  exists(p: string): boolean {
    return this.paths.has(p)
  }

  readdir(p: string): string[] {
    const names = new Set<string>()
    for (const e of this.paths) {
      if (!e.startsWith(p + '\\')) continue
      names.add(e.slice(p.length + 1).split('\\')[0])
    }
    return [...names]
  }

  copy(from: string, to: string): void {
    this.log.push(`copy ${from} -> ${to}`)
    if (this.throwOn.has(`copy:${from}`)) throw new Error('copy refused')
    const moved = [...this.paths].filter((p) => this.under(p, from))
    if (moved.length === 0) throw new Error(`ENOENT ${from}`)
    for (const p of moved) this.paths.add(to + p.slice(from.length))
  }

  rename(from: string, to: string): void {
    this.log.push(`rename ${from} -> ${to}`)
    if (this.throwOn.has(`rename:${from}`)) throw new Error('rename refused')
    this.copy(from, to)
    this.rm(from)
  }

  rm(p: string): void {
    if (this.throwOn.has(`rm:${p}`)) throw new Error('in use')
    for (const e of [...this.paths]) if (this.under(e, p)) this.paths.delete(e)
  }
}

const BASE = 'C:\\Users\\x\\AppData\\Local\\astera\\host-runtime'
const SHIPPED = 'C:\\Program Files\\Astera\\resources\\host-runtime'
const paths = hostRuntimePaths({ base: BASE, nodeVersion: '24.15.0', appVersion: '1.3.21' })

/** A shipped runtime as the installer lays it down. */
function shippedFs(): FakeFs {
  return new FakeFs().add(
    SHIPPED + '\\node.exe',
    SHIPPED + '\\runtime.json',
    SHIPPED + '\\node_modules\\node-pty\\lib\\index.js',
    SHIPPED + '\\builds\\1.3.21\\host.js',
    SHIPPED + '\\builds\\1.3.21\\chunks\\framing-abc.js'
  )
}

/** What the shipped `runtime.json` lists: the files under the node directory that every build shares,
 *  and the files under one build directory. Two lists because the two are missing for different
 *  reasons — a build that is not there yet is an ordinary app update, and a node_modules that is not
 *  there is damage. */
const FILES = {
  node: ['node.exe', 'node_modules\\node-pty\\lib\\index.js'],
  build: ['host.js', 'chunks\\framing-abc.js']
}

function prepare(fs: FakeFs, files: typeof FILES = FILES): ReturnType<typeof prepareHostRuntime> {
  return prepareHostRuntime({
    paths,
    shipped: SHIPPED,
    appVersion: '1.3.21',
    stamp: '7788',
    files,
    fs,
    log: (m) => fs.log.push(`log ${m}`)
  })
}

// `hostRuntimeBase` and `hostRuntimePaths` moved to `src/core/host/runtime.test.ts` along with the
// functions themselves — this file keeps only what still lives here.

describe('staleNodeDirs', () => {
  it('keeps the current Node and names every other one', () => {
    expect(staleNodeDirs(['node-24.15.0', 'node-22.9.0', 'node-25.0.0'], '24.15.0')).toEqual([
      'node-22.9.0',
      'node-25.0.0'
    ])
  })

  it('never names something that is not ours — this list gets deleted', () => {
    expect(staleNodeDirs(['notes', 'node_modules', '.keep', 'node-22.9.0'], '24.15.0')).toEqual(['node-22.9.0'])
  })

  it('does not mistake node-1 for a prefix of node-10', () => {
    expect(staleNodeDirs(['node-1', 'node-10'], '1')).toEqual(['node-10'])
  })
})

describe('staleBuildDirs', () => {
  it('keeps this version and names the rest', () => {
    expect(staleBuildDirs(['1.3.20', '1.3.21', '1.3.19'], '1.3.21')).toEqual(['1.3.20', '1.3.19'])
  })
})

describe('prepareHostRuntime', () => {
  it('falls back when no runtime was shipped — a partial build must not stop the app', () => {
    const fs = new FakeFs()
    expect(prepare(fs)).toMatchObject({ ready: false, did: 'nothing' })
    expect(fs.log.some((l) => l.startsWith('log no host runtime shipped'))).toBe(true)
  })

  it('installs the whole runtime on a machine that has none', () => {
    const fs = shippedFs()
    expect(prepare(fs)).toMatchObject({ ready: true, did: 'node' })
    expect(fs.exists(paths.exePath)).toBe(true)
    expect(fs.exists(paths.entryPath)).toBe(true)
    expect(fs.exists(paths.nodeDir + '\\node_modules\\node-pty\\lib\\index.js')).toBe(true)
  })

  it('lands through a staging directory and a rename, never writing node.exe in place', () => {
    const fs = shippedFs()
    prepare(fs)
    expect(fs.log).toContain(`copy ${SHIPPED} -> ${paths.nodeDir}.staging-7788`)
    expect(fs.log).toContain(`rename ${paths.nodeDir}.staging-7788 -> ${paths.nodeDir}`)
    expect(fs.exists(paths.nodeDir + '.staging-7788')).toBe(false)
  })

  it('writes only the build directory when the Node is already there — the ordinary update', () => {
    const fs = shippedFs().add(paths.exePath, paths.nodeDir + '\\node_modules\\node-pty\\lib\\index.js')
    expect(prepare(fs)).toMatchObject({ ready: true, did: 'build' })
    expect(fs.log.some((l) => l.startsWith(`copy ${SHIPPED} ->`))).toBe(false)
    expect(fs.exists(paths.entryPath)).toBe(true)
  })

  it('does nothing at all when this version has run before', () => {
    const fs = shippedFs()
      .add(...FILES.node.map((f) => `${paths.nodeDir}\\${f}`))
      .add(...FILES.build.map((f) => `${paths.buildDir}\\${f}`))
    expect(prepare(fs)).toMatchObject({ ready: true, did: 'nothing' })
    expect(fs.log.filter((l) => l.startsWith('copy'))).toEqual([])
  })

  it('accepts a lost race: another instance produced the same runtime while this one copied', () => {
    const fs = shippedFs()
    fs.throwOn.add(`rename:${paths.nodeDir}.staging-7788`)
    // What the winner left behind — a whole node directory, because it landed by one rename.
    fs.add(...FILES.node.map((f) => `${paths.nodeDir}\\${f}`))
    expect(prepare(fs)).toMatchObject({ ready: true, did: 'build' })
  })

  it('falls back when the copy fails and nothing appeared, leaving no staging directory behind', () => {
    const fs = shippedFs()
    fs.throwOn.add(`copy:${SHIPPED}`)
    expect(prepare(fs)).toMatchObject({ ready: false, did: 'nothing' })
    expect(fs.exists(paths.nodeDir + '.staging-7788')).toBe(false)
    expect(fs.log.some((l) => l.includes('could not be installed'))).toBe(true)
  })

  it('falls back when the entry cannot be written, even though node.exe is in place', () => {
    const fs = shippedFs().add(...FILES.node.map((f) => `${paths.nodeDir}\\${f}`))
    fs.throwOn.add(`copy:${SHIPPED}\\builds\\1.3.21`)
    expect(prepare(fs)).toMatchObject({ ready: false, did: 'nothing' })
  })
})

// **The 2026-09-22 repair.** A session deleted `%LOCALAPPDATA%\astera` to clear the CLI's `bin` beside
// it; Windows kept the two files the running Host had open — `node.exe` and `conpty.node` — and took
// the rest, including node-pty's JavaScript. `exists(exePath)` was the only question this module
// asked, so the restart that followed believed the runtime was whole, wrote only the build directory,
// and left the Host on a node-pty that could no longer spawn anything (design D5, F6).
describe('prepareHostRuntime — a runtime that is missing files', () => {
  /** A machine where this version has already run: the node directory whole, and this build in it. */
  function installed(): FakeFs {
    return shippedFs()
      .add(...FILES.node.map((f) => `${paths.nodeDir}\\${f}`))
      .add(...FILES.build.map((f) => `${paths.buildDir}\\${f}`))
  }

  it('does nothing when every file the manifest names is there', () => {
    const fs = installed()
    expect(prepare(fs)).toMatchObject({ ready: true, did: 'nothing', incomplete: false })
    expect(fs.log.filter((l) => l.startsWith('copy'))).toEqual([])
  })

  it('reinstalls the whole node directory when one of its files is gone', () => {
    const fs = installed()
    fs.paths.delete(`${paths.nodeDir}\\node_modules\\node-pty\\lib\\index.js`)
    expect(prepare(fs)).toMatchObject({ ready: true, did: 'node', incomplete: false })
    expect(fs.exists(`${paths.nodeDir}\\node_modules\\node-pty\\lib\\index.js`)).toBe(true)
    expect(fs.log.some((l) => l.includes('is missing'))).toBe(true)
  })

  // `host.js` present and a chunk it requires gone is a Host that dies on its first line, and the
  // `exists(entryPath)` test alone reads that as a build already in place.
  it('rewrites the build directory when a chunk is gone, even though host.js is there', () => {
    const fs = installed()
    fs.paths.delete(`${paths.buildDir}\\chunks\\framing-abc.js`)
    expect(prepare(fs)).toMatchObject({ ready: true, did: 'build', incomplete: false })
    expect(fs.exists(`${paths.buildDir}\\chunks\\framing-abc.js`)).toBe(true)
  })

  // The directory most worth replacing is the one a Host is still running out of, and Windows will not
  // delete a locked `node.exe`. Saying so is the point: the caller puts it in the status, the Host is
  // replaced the first moment it holds nothing, and the repair happens then (design F6).
  it('reports the runtime as incomplete when the old Host still holds it', () => {
    const fs = installed()
    fs.paths.delete(`${paths.nodeDir}\\node_modules\\node-pty\\lib\\index.js`)
    fs.throwOn.add(`rm:${paths.nodeDir}`)
    expect(prepare(fs)).toMatchObject({ ready: true, incomplete: true })
    expect(fs.log.some((l) => l.includes('could not be repaired'))).toBe(true)
  })

  // A check that cannot be made is not a failure — the same rule host/nodePtyCheck.ts follows. An
  // empty manifest is a fault in our own packaging, and refusing to start a Host over it would turn
  // that into an app with no Host at all.
  it('skips the check when the manifest names nothing', () => {
    const fs = installed()
    fs.paths.delete(`${paths.nodeDir}\\node_modules\\node-pty\\lib\\index.js`)
    expect(prepare(fs, { node: [], build: [] })).toMatchObject({ ready: true, did: 'nothing', incomplete: false })
    expect(fs.log.some((l) => l.includes('lists no files'))).toBe(true)
  })

  // An ordinary first install, and an ordinary app update. Neither is damage, and calling either one
  // incomplete would put a repair notice on screen for every new machine and every update.
  it('does not call a first install or an update incomplete', () => {
    expect(prepare(shippedFs())).toMatchObject({ ready: true, did: 'node', incomplete: false })
    const updating = shippedFs().add(...FILES.node.map((f) => `${paths.nodeDir}\\${f}`))
    expect(prepare(updating)).toMatchObject({ ready: true, did: 'build', incomplete: false })
  })
})

describe('sweepHostRuntime', () => {
  function sweep(fs: FakeFs): number {
    return sweepHostRuntime({
      paths,
      nodeVersion: '24.15.0',
      appVersion: '1.3.21',
      fs,
      log: (m) => fs.log.push(`log ${m}`)
    })
  }

  it('removes other Nodes and other builds, and keeps this version untouched', () => {
    const fs = new FakeFs().add(
      paths.exePath,
      paths.entryPath,
      BASE + '\\node-22.9.0\\node.exe',
      paths.buildsDir + '\\1.3.20\\host.js'
    )
    expect(sweep(fs)).toBe(2)
    expect(fs.exists(BASE + '\\node-22.9.0\\node.exe')).toBe(false)
    expect(fs.exists(paths.buildsDir + '\\1.3.20\\host.js')).toBe(false)
    expect(fs.exists(paths.exePath)).toBe(true)
    expect(fs.exists(paths.entryPath)).toBe(true)
  })

  it('clears a staging directory an interrupted copy left behind', () => {
    const fs = new FakeFs().add(paths.exePath, paths.entryPath, `${paths.nodeDir}.staging-4242\\node.exe`)
    expect(sweep(fs)).toBe(1)
    expect(fs.exists(`${paths.nodeDir}.staging-4242\\node.exe`)).toBe(false)
  })

  it('keeps going when a directory is locked — an old Host still holds its node.exe', () => {
    const fs = new FakeFs().add(
      paths.exePath,
      BASE + '\\node-22.9.0\\node.exe',
      paths.buildsDir + '\\1.3.20\\host.js'
    )
    fs.throwOn.add(`rm:${BASE}\\node-22.9.0`)
    expect(sweep(fs)).toBe(1)
    expect(fs.exists(BASE + '\\node-22.9.0\\node.exe')).toBe(true) // retried next launch
    expect(fs.exists(paths.buildsDir + '\\1.3.20\\host.js')).toBe(false)
  })

  it('says nothing when there was nothing to sweep', () => {
    const fs = new FakeFs().add(paths.exePath, paths.entryPath)
    expect(sweep(fs)).toBe(0)
    expect(fs.log).toEqual([])
  })
})
