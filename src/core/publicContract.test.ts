// The app reads the public contract from the SDK package (packages/client), one copy for the CLI, MCP and the SDK.
import { describe, it, expect } from 'vitest'
import * as pkg from '../../packages/client/src/index.js'
import * as cliOutput from './orchestration/cliOutput'

describe('the app uses the package contract', () => {
  it('the CLI error codes and their mapping are the package ones', () => {
    expect(cliOutput.CLI_ERROR_CODES).toBe(pkg.ERROR_CODES)
    expect(cliOutput.REMOTE_ERROR_CODES).toBe(pkg.REMOTE_ERROR_CODES)
    expect(cliOutput.codeForStatus).toBe(pkg.codeForStatus)
    expect(cliOutput.exitCodeFor).toBe(pkg.exitCodeFor)
    expect(cliOutput.remoteCodeOf).toBe(pkg.remoteCodeOf)
  })
})

// Final review of SDK 1a: the app reaches the package through this one module, so the boundary has one door. Tests
// may import the package directly to compare against it.
describe('one door into the package', () => {
  it('no app source but publicContract.ts imports packages/client', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const path = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(ts|tsx|mts|cts)$/.test(e.name) && !/\.test\.(ts|tsx|mts|cts)$/.test(e.name) ? [path.join(dir, e.name)] : []
      )
    const doors = walk(srcRoot)
      // Import and export specifiers only: a comment that names the package (between two apostrophes) is not a door
      .filter((f) => /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"][^'"\n]*packages\/client[^'"\n]*['"]/.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(srcRoot, f).split(path.sep).join('/'))
    // publicProtocol.ts is the second door, the one the renderer may reach (SDK 1b)
    expect(doors.sort()).toEqual(['core/publicContract.ts', 'core/publicProtocol.ts'])
  })

  // What the renderer reaches through publicProtocol.ts must import nothing: the main door carries node:crypto,
  // node:fs and node:net, and a renderer bundle must never pull those in.
  it('the renderer-safe door opens a module that imports nothing', async () => {
    const { readFileSync } = await import('node:fs')
    const door = readFileSync(new URL('./publicProtocol.ts', import.meta.url), 'utf8')
    const opened = [...door.matchAll(/^(?:import|export) .* from '\.\.\/\.\.\/packages\/client\/src\/([\w-]+)\.js'$/gm)].map((m) => m[1])
    expect(opened.sort()).toEqual(['deadlines', 'protocol'])
    expect(door.match(/^(?:import|export) .* from /gm)).toHaveLength(opened.length)
    for (const name of opened) {
      const target = readFileSync(new URL(`../../packages/client/src/${name}.ts`, import.meta.url), 'utf8')
      expect(target, name).not.toMatch(/^\s*(import|export)\b[^\n]*\bfrom\s*['"]/m)
      expect(target, name).not.toMatch(/\bimport\s*\(/)
    }
  })
})

// SDK 1b: the Host transport is the package's too. Each app module is a shim over it.
describe('the app uses the package transport', () => {
  it('framing, the host key, the socket folder check, the address, discovery and the protocol constant', async () => {
    const internal = await import('../../packages/client/src/internal.js')
    const framing = await import('../host/framing')
    const hostKey = await import('./host/hostKey')
    const socketDir = await import('./host/socketDir')
    const address = await import('../host/address')
    const discovery = await import('./orchestration/cliDiscovery')
    const protocol = await import('./host/protocol')
    expect(framing.encodeLine).toBe(internal.encodeLine)
    expect(framing.createLineReader).toBe(internal.createLineReader)
    for (const k of ['hostKeyPath', 'readHostKey', 'ensureHostKey', 'newHostNonce', 'hostProof', 'proofMatches', 'appKeyPath', 'readAppKey', 'readAppKeySync', 'ensureAppKey', 'appProof', 'appProofMatches'] as const)
      expect(hostKey[k], k).toBe(internal[k])
    expect(socketDir.unsafeSocketDir).toBe(internal.unsafeSocketDir)
    expect(socketDir.privateDirProblem).toBe(internal.privateDirProblem)
    expect(address.hostAddress).toBe(internal.hostAddress)
    expect(discovery.userDataDir).toBe(internal.userDataDir)
    expect(discovery.nativePath).toBe(internal.nativePath)
    expect(protocol.HOST_PROTOCOL).toBe(internal.HOST_PROTOCOL)
    expect(protocol.HOST_FEATURE_REQUESTS).toBe(internal.HOST_FEATURE_REQUESTS)
  })

  // SDK 1c: following a Run is the package's rule too
  it('the follow key and window', async () => {
    const internal = await import('../../packages/client/src/internal.js')
    const cliFollow = await import('./orchestration/cliFollow')
    const command = await import('./orchestration/command')
    expect(cliFollow.eventKey).toBe(internal.eventKey)
    expect(command.FOLLOW_WINDOW_MS).toBe(internal.FOLLOW_WINDOW_MS)
  })

  it('the published entry is the error contract (and the client), not the app internals', async () => {
    const published: Record<string, unknown> = await import('../../packages/client/src/index.js')
    expect('AsteraError' in published).toBe(true)
    for (const k of ['publicFor', 'encodeLine', 'hostAddress', 'JOB_FIELDS', 'hostTarget', 'createNamespaces']) expect(k in published, k).toBe(false)
  })
})
