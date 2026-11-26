// The language servers Astera installs (Phase 3 Part 3), after the person approves each in Settings: every pinned
// package (core/lsp/servers.ts) fetched with `npm pack` (the npm the plugins use, every call with --ignore-scripts), its
// tarball's sha512 checked against the pin before anything is extracted, its name and version checked after, and moved
// into `<profile>/language-servers/<name>@<version>/package`. Nothing is `npm install`ed: no pinned package has runtime
// dependencies. A staging folder holds each fetch and is removed whatever happens.
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { NpmFailed, npmOutputTail, type NpmRun } from '../plugins/npm'
import { extractPackage } from '../plugins/tarball'
import { moveRetrying } from '../plugins/moves'
import { serverPackages } from '../../core/lsp/servers'
import type { LspInstalled, LspServerId, PinnedPackage } from '../../core/lsp/model'

/** The tarball is not the one pinned: a registry gave other bytes for that exact version. */
export class LspIntegrityFailed extends Error {
  readonly code = 'LSP_INTEGRITY'
}

/** TypeScript 7 has no package for this platform and CPU. */
export class LspUnavailable extends Error {
  readonly code = 'LSP_UNAVAILABLE'
}

const SERVERS: readonly LspServerId[] = ['typescript', 'typescript5', 'python']

export const lspDir = (profileDir: string): string => path.join(profileDir, 'language-servers')

/** A package's own folder: `@scope/name` written `scope+name`, beside its version. */
export const packageDir = (profileDir: string, p: PinnedPackage): string =>
  path.join(lspDir(profileDir), `${p.name.replace(/^@/, '').replace('/', '+')}@${p.version}`, 'package')

const sha512Of = async (file: string): Promise<string> => `sha512-${createHash('sha512').update(await fs.readFile(file)).digest('base64')}`

const readPackage = async (folder: string): Promise<{ name?: unknown; version?: unknown } | null> => {
  try {
    return JSON.parse((await fs.readFile(path.join(folder, 'package.json'), 'utf8')).replace(/^﻿/, '')) as { name?: unknown; version?: unknown }
  } catch {
    return null
  }
}

export function createLspInstaller(d: {
  profileDir: string
  npm: NpmRun
  platform?: string
  arch?: string
  /** For tests: the pins (serverPackages by default). */
  pins?: (id: LspServerId) => PinnedPackage[] | null
}): {
  installed(id: LspServerId): Promise<boolean>
  install(id: LspServerId): Promise<void>
  remove(id: LspServerId): Promise<void>
  list(): Promise<LspInstalled[]>
} {
  const pins = d.pins ?? ((id: LspServerId) => serverPackages(id, d.platform ?? process.platform, d.arch ?? process.arch))
  const root = lspDir(d.profileDir)

  const isInstalled = async (p: PinnedPackage): Promise<boolean> => {
    const pkg = await readPackage(packageDir(d.profileDir, p))
    return pkg?.name === p.name && pkg?.version === p.version
  }

  const fetchOne = async (p: PinnedPackage): Promise<void> => {
    await fs.mkdir(root, { recursive: true })
    const staging = path.join(root, `.staging-${randomUUID()}`)
    await fs.mkdir(staging)
    try {
      const spec = `${p.name}@${p.version}`
      // The arguments packAndExtract uses; extraction waits for the checksum
      const r = await d.npm(['pack', spec, '--prefix', '.', '--ignore-scripts', '--pack-destination', '.'], { cwd: staging })
      if (r.code !== 0) throw new NpmFailed(`npm could not fetch ${spec}: ${npmOutputTail(r.stderr || r.stdout, 6)}`, /\b(?:E404|ETARGET)\b/.test(r.stderr + r.stdout))
      const tarballs = (await fs.readdir(staging)).filter((n) => n.endsWith('.tgz'))
      if (tarballs.length !== 1) throw new NpmFailed(`npm fetched ${spec} but wrote ${tarballs.length} tarballs`)
      const tgz = path.join(staging, tarballs[0])
      const got = await sha512Of(tgz)
      if (got !== p.integrity) throw new LspIntegrityFailed(`${spec} is not the package Astera pinned: its sha512 is ${got}, not ${p.integrity}`)
      const folder = path.join(staging, 'package')
      await extractPackage(tgz, folder)
      const pkg = await readPackage(folder)
      if (pkg?.name !== p.name || pkg?.version !== p.version) throw new LspIntegrityFailed(`${spec} holds ${String(pkg?.name)}@${String(pkg?.version)}`)
      const dest = packageDir(d.profileDir, p)
      await fs.rm(path.dirname(dest), { recursive: true, force: true })
      await fs.mkdir(path.dirname(dest), { recursive: true })
      await moveRetrying(folder, dest)
    } finally {
      await fs.rm(staging, { recursive: true, force: true })
    }
  }

  const packagesOf = (id: LspServerId): PinnedPackage[] => {
    const list = pins(id)
    if (list === null) throw new LspUnavailable(`there is no ${id === 'typescript' ? 'TypeScript 7' : id} package for ${d.platform ?? process.platform} ${d.arch ?? process.arch}`)
    return list
  }

  return {
    async installed(id) {
      const list = pins(id)
      if (list === null) return false
      for (const p of list) if (!(await isInstalled(p))) return false
      return true
    },
    async install(id) {
      for (const p of packagesOf(id)) await fetchOne(p)
    },
    async remove(id) {
      for (const p of pins(id) ?? []) await fs.rm(path.dirname(packageDir(d.profileDir, p)), { recursive: true, force: true })
    },
    async list() {
      const out: LspInstalled[] = []
      for (const server of SERVERS) {
        const packages = pins(server)
        let installed = packages !== null
        for (const p of packages ?? []) if (!(await isInstalled(p))) installed = false
        out.push({ server, available: packages !== null, installed, packages: packages ?? [], folder: root })
      }
      return out
    }
  }
}
