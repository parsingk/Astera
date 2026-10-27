// The Credentials list's login presets measured against their own tools (enforce and sandbox design §8): a fake config
// where the tool looks by default, read before the preset applies and not after it.
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import { PRESETS } from '../../src/core/credentials/presets'
import { PRESET_PROBES, measurePresets, presetEnv, presetVerdict } from './presets.mjs'

describe('PRESET_PROBES', () => {
  it('has a probe for every preset, with the preset’s own values', () => {
    expect(Object.keys(PRESET_PROBES)).toEqual(PRESETS.map((p) => p.id))
    for (const p of PRESETS) {
      expect(PRESET_PROBES[p.id].remove, p.id).toEqual(p.remove)
      expect(PRESET_PROBES[p.id].redirect, p.id).toEqual(p.redirect)
      expect(PRESET_PROBES[p.id].argv.length, p.id).toBeGreaterThan(0)
      expect(Object.values(PRESET_PROBES[p.id].files).join('\n'), p.id).toContain(PRESET_PROBES[p.id].marker)
    }
  })
})

describe('presetEnv', () => {
  it('takes the preset’s variables away and points the others at empty places', () => {
    const scratch = path.resolve('/s')
    const { env, make } = presetEnv({ GH_TOKEN: 't', GITHUB_TOKEN: 'g', PATH: '/bin' }, PRESET_PROBES.gh, scratch)
    expect(env).not.toHaveProperty('GH_TOKEN')
    expect(env).not.toHaveProperty('GITHUB_TOKEN')
    expect(env.PATH).toBe('/bin')
    expect(env.GH_CONFIG_DIR.startsWith(scratch)).toBe(true)
    expect(make).toEqual([{ path: env.GH_CONFIG_DIR, kind: 'dir' }])
    const aws = presetEnv({}, PRESET_PROBES.aws, scratch)
    expect(aws.make).toEqual([
      { path: aws.env.AWS_CONFIG_FILE, kind: 'file' },
      { path: aws.env.AWS_SHARED_CREDENTIALS_FILE, kind: 'file' }
    ])
    expect(aws.env.AWS_CONFIG_FILE).not.toBe(aws.env.AWS_SHARED_CREDENTIALS_FILE)
  })
})

describe('presetVerdict', () => {
  it('says a preset is unmeasured where its tool is missing', () => {
    expect(presetVerdict({ missing: true, out: '' }, { missing: true, out: '' }, 'm')).toBe('missing')
    expect(presetVerdict({ missing: false, out: 'logged in as m' }, { missing: false, out: 'not logged in' }, 'm')).toBe('hides')
    expect(presetVerdict({ missing: false, out: 'm' }, { missing: false, out: 'm' }, 'm')).toBe('does-not-hide')
    expect(presetVerdict({ missing: false, out: 'x' }, { missing: false, out: 'y' }, 'm')).toBe('not-read')
  })
})

describe('measurePresets', () => {
  it('writes each fake config, runs the tool before and after the preset, and makes the empty places', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'astera-presets-'))
    try {
      const home = path.join(root, 'home')
      const scratch = path.join(root, 'scratch')
      const seen = []
      // A tool that reads its login unless one of its preset's variables points elsewhere
      const run = (argv, env) => {
        const id = Object.keys(PRESET_PROBES).find((k) => PRESET_PROBES[k].argv[0] === argv[0])
        const probe = PRESET_PROBES[id]
        seen.push(Object.keys(probe.redirect).map((v) => env[v]).filter(Boolean))
        return { missing: false, out: Object.keys(probe.redirect).some((v) => env[v]) ? 'nothing' : probe.marker }
      }
      const results = measurePresets(home, scratch, run, { PATH: '/bin' })
      expect(results.map((r) => [r.id, r.verdict])).toEqual(Object.keys(PRESET_PROBES).map((id) => [id, 'hides']))
      expect(readFileSync(path.join(home, '.aws/credentials'), 'utf8')).toContain('AKIAASTERAPROBE00001')
      for (const paths of seen.filter((p) => p.length > 0)) for (const p of paths) expect(existsSync(p), p).toBe(true)
      expect(statSync(path.join(scratch, 'gh', 'gh_config_dir')).isDirectory()).toBe(true)
      expect(statSync(path.join(scratch, 'npm', 'npm_config_userconfig')).isFile()).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
