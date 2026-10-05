import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { findRealHiggsfield, hfShimFiles, isHfShim, npmShimTarget } from './shims'

describe('higgsfield shims', () => {
  it('writes a .cmd and an sh file per name on win32, sh only elsewhere', () => {
    expect(hfShimFiles('win32').map((f) => f.name).sort()).toEqual(
      ['hf', 'hf.cmd', 'higgs', 'higgs.cmd', 'higgsfield', 'higgsfield.cmd'])
    expect(hfShimFiles('linux').map((f) => f.name).sort()).toEqual(['hf', 'higgs', 'higgsfield'])
  })

  it('forwards every argument to the shuttle beside it', () => {
    const cmd = hfShimFiles('win32').find((f) => f.name === 'hf.cmd')!.content
    expect(cmd).toBe('@echo off\r\n"%~dp0astera.cmd" hf-proxy %*\r\n')
    const sh = hfShimFiles('linux').find((f) => f.name === 'hf')!.content
    expect(sh).toBe('#!/bin/sh\nexec "$(dirname "$0")/astera" hf-proxy "$@"\n')
  })

  it('recognises its own files and nothing else', () => {
    for (const f of hfShimFiles('win32')) expect(isHfShim(f.content)).toBe(true)
    expect(isHfShim('@echo off\r\nnode "%~dp0node_modules\\@higgsfield\\cli\\bin.js" %*')).toBe(false)
  })

  const W = path.win32
  const files: Record<string, string> = {
    'C:\\p\\orch\\higgsfield.cmd': '@echo off\r\n"%~dp0astera.cmd" hf-proxy %*\r\n',
    'C:\\q\\orch\\higgsfield.cmd': '@echo off\r\n"%~dp0astera.cmd" hf-proxy %*\r\n',
    'C:\\Program Files\\nodejs\\higgsfield.cmd': '@echo off\r\nnode real\r\n'
  }
  const read = (p: string) => files[p] ?? null

  it('skips every folder whose higgsfield is our shim, not only the named one', () => {
    const env = { Path: 'C:\\p\\orch;C:\\q\\orch;C:\\Program Files\\nodejs', PATHEXT: '.COM;.EXE;.BAT;.CMD' }
    expect(findRealHiggsfield({ env, platform: 'win32', skipDirs: ['C:\\p\\orch'], read }))
      .toBe(W.join('C:\\Program Files\\nodejs', 'higgsfield.cmd'))
  })

  it('answers null when only shims are on PATH', () => {
    const env = { PATH: 'C:\\p\\orch', PATHEXT: '.CMD' }
    expect(findRealHiggsfield({ env, platform: 'win32', skipDirs: [], read })).toBeNull()
  })

  it('falls back to hf and higgs when higgsfield is absent', () => {
    const env = { PATH: '/usr/local/bin' }
    const r = (p: string) => (p === '/usr/local/bin/hf' ? '#!/usr/bin/env node' : null)
    expect(findRealHiggsfield({ env, platform: 'linux', skipDirs: [], read: r })).toBe('/usr/local/bin/hf')
  })
})

describe('npmShimTarget', () => {
  // The shape npm's cmd-shim writes (read from C:\Program Files\nodejs\higgsfield.cmd).
  const SHIM = [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
    String.raw`IF EXIST "%dp0%\node.exe" (`, String.raw`  SET "_prog=%dp0%\node.exe"`, ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
    String.raw`endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\@higgsfield\cli\bin\higgsfield.js" %*`, ''
  ].join('\r\n')
  const file = String.raw`C:\Program Files\nodejs\higgsfield.cmd`
  const nodeBeside = String.raw`C:\Program Files\nodejs\node.exe`
  const read = (p: string) => (p === file ? SHIM : null)

  it('finds the script and uses node.exe beside the shim when present', () => {
    const t = npmShimTarget(file, read, { exists: (p) => p === nodeBeside })
    expect(t).toEqual({ node: nodeBeside, script: String.raw`C:\Program Files\nodejs\node_modules\@higgsfield\cli\bin\higgsfield.js`, electronAsNode: false })
  })
  it('falls back to node on PATH, then to this executable as node', () => {
    const onPath = npmShimTarget(file, read, { exists: (p) => p === String.raw`C:\n\node.exe`, env: { PATH: String.raw`C:\n` } })
    expect(onPath?.node).toBe(String.raw`C:\n\node.exe`)
    const self = npmShimTarget(file, read, { exists: () => false, env: { PATH: '' }, selfExecPath: String.raw`C:\app\astera.exe` })
    expect(self).toMatchObject({ node: String.raw`C:\app\astera.exe`, electronAsNode: true })
  })
  it('accepts only node.exe from PATH, never a node.cmd version-manager shim', () => {
    const cmdOnly = npmShimTarget(file, read, { exists: (p) => p === String.raw`C:\n\node.cmd`, env: { PATH: String.raw`C:\n`, PATHEXT: '.CMD;.EXE' }, selfExecPath: String.raw`C:\app\astera.exe` })
    expect(cmdOnly).toMatchObject({ node: String.raw`C:\app\astera.exe`, electronAsNode: true })
  })
  it('does not read node.exe as text to see whether it exists (default exists check)', () => {
    const reads: string[] = []
    npmShimTarget(file, (p) => { reads.push(p); return p === file ? SHIM : null }, { env: { PATH: '' }, selfExecPath: 'x' })
    expect(reads).toEqual([file])
  })
  it('is null for a .cmd that is not an npm shim', () => {
    expect(npmShimTarget(String.raw`C:\x\a.cmd`, () => '@echo hi\r\n')).toBeNull()
    expect(npmShimTarget(String.raw`C:\x\missing.cmd`, () => null)).toBeNull()
  })
})
