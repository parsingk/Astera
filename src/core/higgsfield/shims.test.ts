import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { findRealHiggsfield, hfShimFiles, isHfShim } from './shims'

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
