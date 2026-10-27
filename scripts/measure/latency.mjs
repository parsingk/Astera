// What starting the Enforce hook costs per tool call (enforce and sandbox design §10.5, S1's review M6). The hook is the
// text the build bundles into an out/main chunk (`ENFORCE_HOOK_SOURCE`), written to a file and run the way a CLI runs
// it: `<interpreter> <hook> claude`, a Bash call on stdin, ASTERA_SESSION set so it writes its line too.
import { spawnSync } from 'node:child_process'
import path from 'node:path'

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

/** Times `runs` starts of the hook under each interpreter. */
export function measureHook(o) {
  const runs = o.runs ?? 20
  const payload = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'git status' },
    tool_use_id: 'toolu_probe',
    cwd: path.dirname(o.hookFile)
  })
  const out = {}
  for (const i of o.interpreters) {
    const ms = []
    for (let n = 0; n < runs; n++) {
      const started = process.hrtime.bigint()
      spawnSync(i.file, [o.hookFile, 'claude'], { input: payload, env: { ...process.env, ...i.env, ASTERA_SESSION: 'probe' }, encoding: 'utf8' })
      ms.push(Number(process.hrtime.bigint() - started) / 1e6)
    }
    out[i.name] = stats(ms)
  }
  return out
}
