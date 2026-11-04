// The hooks Codex loads for the shared plugins, and the trust that keeps its "Hooks need review" menu from stopping an
// unattended session. Codex files a plugin's hooks under a key such as
// `probe@astera-shared:hooks/hooks.json:pre_tool_use:0:0`, and which file it reads and what the key's middle part says
// depend on how the plugin's manifest spells its hooks (measured on codex-cli 0.160), so Astera does not rebuild the key
// or the hash: it asks Codex itself. `codex app-server` is started for one `hooks/list` and killed; no thread is started
// and no prompt is sent. What it answers is written into the account's `config.toml` as
// `[hooks.state."<key>"] trusted_hash = "<hash>"` (trustPatch), the entry Codex writes itself when a person accepts.
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { killProcessTree } from '../../run/kill'
import { resolveCliCommand, type CliLookup } from '../claudePlugins/cli'
import { codexPluginCliEnv } from './cli'

export interface CodexHookRow {
  /** Codex's own key for the hook, the one `hooks.state` is keyed by. */
  key: string
  /** `name@marketplace` of the plugin that brought the hook; null for a hook of the person's own. */
  pluginId: string | null
  /** What Codex hashes the hook to now; written as `trusted_hash`. */
  currentHash: string
  trustStatus: string
}

/** The hooks Codex loads in `cwd` for the account at `codexHome` (null: the ambient `~/.codex` account). Rejects with
 *  the reason when Codex could not be asked or did not answer. */
export type CodexHooksList = (codexHome: string | null, cwd: string) => Promise<CodexHookRow[]>

/** A cold `codex app-server` starts and answers in a few seconds. */
const HOOKS_LIST_TIMEOUT_MS = 30_000
/** Codex's schema requires a client version, and nothing here depends on it. */
const CLIENT_VERSION = '0'
/** What of the child's stderr goes into the reason when it exits before answering. */
const STDERR_TAIL_CHARS = 500

const INITIALIZE_ID = 1
const HOOKS_LIST_ID = 2

type Table = Record<string, unknown>
const isTable = (v: unknown): v is Table => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The rows in a `hooks/list` result: `data[].hooks[]`. A hook without a key, a hash or a trust status cannot be compared
 *  or trusted, so it is left out; an answer with no `data` list is not read as "no hooks" (that would have the stale
 *  trust of every plugin dropped), it throws. */
function rowsOf(result: unknown): CodexHookRow[] {
  const data = isTable(result) ? result.data : undefined
  if (!Array.isArray(data)) throw new Error('codex answered hooks/list with no data list')
  const rows: CodexHookRow[] = []
  for (const entry of data) {
    const hooks = isTable(entry) ? entry.hooks : undefined
    if (!Array.isArray(hooks)) continue
    for (const h of hooks) {
      if (!isTable(h) || typeof h.key !== 'string' || typeof h.currentHash !== 'string' || typeof h.trustStatus !== 'string') continue
      rows.push({ key: h.key, pluginId: typeof h.pluginId === 'string' ? h.pluginId : null, currentHash: h.currentHash, trustStatus: h.trustStatus })
    }
  }
  return rows
}

export function createCodexHooksList(
  d: Omit<CliLookup, 'name'> & {
    /** What each run's environment starts from. A function is read at each run, after `refreshPath`. */
    baseEnv: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv)
    spawn?: typeof nodeSpawn
    timeoutMs?: number
  }
): CodexHooksList {
  return async (codexHome, cwd) => {
    const cmd = await resolveCliCommand(
      { name: 'codex', platform: d.platform, resolve: d.resolve, warm: d.warm, refreshPath: d.refreshPath },
      ['app-server'],
      () => codexPluginCliEnv(typeof d.baseEnv === 'function' ? d.baseEnv() : d.baseEnv, codexHome)
    )
    if ('refused' in cmd) throw new Error(cmd.refused)
    const ms = d.timeoutMs ?? HOOKS_LIST_TIMEOUT_MS
    return new Promise<CodexHookRow[]>((resolve, reject) => {
      let child: ChildProcess
      try {
        const opts: SpawnOptions = { cwd, env: cmd.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
        child = (d.spawn ?? nodeSpawn)(cmd.file, cmd.args, opts)
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
        return
      }
      let settled = false
      let waitingFor: { id: number; method: string } = { id: INITIALIZE_ID, method: 'initialize' }
      let buffer = ''
      let stderr = ''
      // Whatever the outcome, nothing of the app-server is left running: the whole tree, as on win32 it may be under cmd.exe
      const settle = (done: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(limit)
        killProcessTree(child)
        done()
      }
      const fail = (message: string): void => settle(() => reject(new Error(message)))
      const send = (message: object): void => {
        child.stdin?.write(`${JSON.stringify(message)}\n`)
      }

      const onMessage = (message: unknown): void => {
        // A notification has no id, and a request Codex makes of its client has a method: neither is an answer
        if (!isTable(message) || typeof message.method === 'string' || message.id !== waitingFor.id) return
        if (message.error !== undefined) {
          const e = message.error
          fail(isTable(e) && typeof e.message === 'string' ? e.message : `codex answered ${waitingFor.method} with an error: ${JSON.stringify(e)}`)
          return
        }
        if (waitingFor.id === INITIALIZE_ID) {
          // Codex takes nothing else before it has answered initialize
          waitingFor = { id: HOOKS_LIST_ID, method: 'hooks/list' }
          send({ method: 'initialized' })
          send({ id: HOOKS_LIST_ID, method: 'hooks/list', params: { cwds: [cwd] } })
          return
        }
        let rows: CodexHookRow[]
        try {
          rows = rowsOf(message.result)
        } catch (e) {
          fail((e as Error).message)
          return
        }
        settle(() => resolve(rows))
      }

      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (s: string) => {
        buffer += s
        let end: number
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end).trim()
          buffer = buffer.slice(end + 1)
          if (line === '') continue
          let message: unknown
          try {
            message = JSON.parse(line)
          } catch {
            continue // a log line, not a message
          }
          onMessage(message)
          if (settled) return
        }
      })
      child.stderr?.on('data', (s: string) => {
        stderr += s
      })
      // Codex closing the pipe makes the next write fail; why it died is what the exit reports
      child.stdin?.on('error', () => undefined)
      child.on('error', (e) => fail(e.message))
      child.on('close', (code) => {
        const tail = stderr.trim().slice(-STDERR_TAIL_CHARS)
        fail(tail !== '' ? tail : `codex app-server exited with code ${code} before it answered`)
      })
      const limit = setTimeout(() => fail(`codex app-server did not answer ${waitingFor.method} within ${Math.round(ms / 1000)} s`), ms)

      send({ id: INITIALIZE_ID, method: 'initialize', params: { clientInfo: { name: 'astera', version: CLIENT_VERSION } } })
    })
  }
}

/** `current` (a `config.toml` as `readTomlObject` returns it) with `hooks.state` made to trust each `trust` entry's hash
 *  and to hold no key `drop` picks. A key that is both is trusted. Every other key of `current` and of `hooks`, a
 *  person's own `hooks.state` keys, and the other fields of an entry that is kept stay as they are. A patch that changes
 *  nothing returns `current` itself, so the file is not written. */
export function trustPatch(
  current: Record<string, unknown>,
  a: { trust: { key: string; hash: string }[]; drop: (key: string) => boolean }
): Record<string, unknown> {
  const hooks = isTable(current.hooks) ? current.hooks : null
  // The parser's tables have no prototype and are rebuilt as plain objects; a Map keeps each key where it was
  const state = new Map<string, unknown>(hooks !== null && isTable(hooks.state) ? Object.entries(hooks.state) : [])
  let changed = false
  for (const key of [...state.keys()]) {
    if (!a.drop(key)) continue
    state.delete(key)
    changed = true
  }
  for (const { key, hash } of a.trust) {
    const entry = state.get(key)
    if (isTable(entry) && entry.trusted_hash === hash) continue
    state.set(key, { ...(isTable(entry) ? entry : {}), trusted_hash: hash })
    changed = true
  }
  if (!changed) return current
  const nextHooks = new Map<string, unknown>(hooks === null ? [] : Object.entries(hooks))
  if (state.size > 0) nextHooks.set('state', Object.fromEntries(state))
  else nextHooks.delete('state')
  const next = new Map<string, unknown>(Object.entries(current))
  if (nextHooks.size > 0) next.set('hooks', Object.fromEntries(nextHooks))
  else next.delete('hooks')
  return Object.fromEntries(next)
}
