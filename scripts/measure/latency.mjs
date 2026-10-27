// What starting the Enforce hook costs per tool call (enforce and sandbox design §10.5, S1's review M6). The hook is the
// text the build bundles into an out/main chunk (`ENFORCE_HOOK_SOURCE`), written to a file beside the Rules
// (`audit-policy.json`, as the app writes them) and run the way a CLI runs it: `<interpreter> <hook> claude`, a Bash call
// on stdin, ASTERA_SESSION set so it writes its line too.
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'

/** The starter Rules (src/core/audit/policy.ts STARTER_POLICY, which latency.test.mjs pins equal) in enforce mode. */
export const HOOK_POLICY = {
  version: 1,
  mode: 'enforce',
  rules: [
    { id: 'starter-git-remote-write', effect: 'deny', action: 'git.remote.write' },
    { id: 'starter-github-pr-create', effect: 'deny', action: 'github.pr.create' },
    { id: 'starter-github-write', effect: 'deny', action: 'github.write' },
    { id: 'starter-write-outside', effect: 'deny', action: 'filesystem.write', scope: 'outside-project' },
    { id: 'starter-delete-outside', effect: 'deny', action: 'filesystem.delete', scope: 'outside-project' }
  ],
  otherwise: 'allow'
}

const DENIED = 'git push origin main'

const LITERAL = /const ENFORCE_HOOK_SOURCE = ('(?:[^'\\]|\\.)*')/

/** The bundled hook's text from a chunk of out/main, or null when the chunk does not hold it. */
export function extractHookSource(chunkText) {
  const m = LITERAL.exec(chunkText)
  return m ? Function(`return ${m[1]}`)() : null
}

const round = (n) => Math.round(n * 10) / 10

/** The runs' median and 90th percentile (nearest rank), in ms to one decimal. */
export function stats(ms) {
  const s = [...ms].sort((a, b) => a - b)
  const mid = s.length / 2
  const median = s.length % 2 === 1 ? s[Math.floor(mid)] : (s[mid - 1] + s[mid]) / 2
  const p90 = s[Math.max(0, Math.ceil(0.9 * s.length) - 1)]
  return { runs: s.length, median: round(median), p90: round(p90) }
}

/** Times `runs` starts of the hook under each interpreter, with HOOK_POLICY written beside it, on a call the Rules let
 *  through. Each interpreter first has to deny what the Rules deny: the hook exits 0 even when it fails inside, so only
 *  its answer shows it read the Rules. */
export function measureHook(o) {
  const runs = o.runs ?? 20
  const dir = path.dirname(o.hookFile)
  writeFileSync(path.join(dir, 'audit-policy.json'), JSON.stringify(HOOK_POLICY))
  const payload = (command) =>
    JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_probe', cwd: dir })
  const out = {}
  for (const i of o.interpreters) {
    const start = (command) =>
      spawnSync(i.file, [o.hookFile, 'claude'], { input: payload(command), env: { ...process.env, ...i.env, ASTERA_SESSION: 'probe' }, encoding: 'utf8', timeout: 20_000 })
    // An interpreter that cannot run the hook is said so, never timed as a fast start
    const failed = (r) => (r.error ? String(r.error.message) : r.status !== 0 ? `exit ${r.status}: ${(r.stderr ?? '').slice(0, 300)}` : null)
    const denied = start(DENIED)
    let error = failed(denied)
    if (error === null && !/"permissionDecision":\s*"deny"/.test(denied.stdout)) error = `the hook did not deny ${DENIED}: ${JSON.stringify(denied.stdout.slice(0, 300))}`
    const ms = []
    for (let n = 0; n < runs && error === null; n++) {
      const started = process.hrtime.bigint()
      const r = start('git status')
      ms.push(Number(process.hrtime.bigint() - started) / 1e6)
      error = failed(r)
    }
    out[i.name] = error === null ? stats(ms) : { error }
  }
  return out
}
