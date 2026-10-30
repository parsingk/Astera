// The hook as it ships (enforce design §5): one file the build bundles, run by node from the profile folder it was written
// into, deciding a real payload on stdin.
import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { promises as fs, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import source from 'virtual:astera-enforce-hook'
import { STARTER_POLICY } from '../policy'
import { removeFixture } from '../../testFixtures'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})

describe('the bundled enforce hook', () => {
  it('the bundled hook decides a real payload', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-enforce-hook-'))
    dirs.push(dir)
    const script = path.join(dir, 'astera-enforce-hook.cjs')
    await fs.writeFile(script, source)
    await fs.writeFile(path.join(dir, 'audit-policy.json'), JSON.stringify({ ...STARTER_POLICY, mode: 'enforce' }))
    // The session works in a project of its own: a call that runs in the settings folder and does more than read it is
    // the settings built-in's (ruling R-F11)
    const project = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-enforce-project-'))
    dirs.push(project)
    const payload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin main' }, tool_use_id: 'toolu_9', cwd: project })
    const r = spawnSync(process.execPath, [script, 'claude'], { input: payload, encoding: 'utf8', env: { ...process.env, ASTERA_SESSION: 'sess_x' }, timeout: 20_000 })
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Blocked by Astera Rules: git.remote.write is denied.' }
    })
    expect(existsSync(path.join(dir, 'enforce', 'sess_x.jsonl'))).toBe(true)
    // An allowed call prints nothing
    const ok = spawnSync(process.execPath, [script, 'claude'], { input: payload.replace('git push origin main', 'git status'), encoding: 'utf8', env: { ...process.env, ASTERA_SESSION: 'sess_x' }, timeout: 20_000 })
    expect(ok.status).toBe(0)
    expect(ok.stdout).toBe('')
  })
})
