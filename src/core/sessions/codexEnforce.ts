// Enforce in a Codex session (enforce design §5): the blocking hook and the trust Codex needs before it runs a hook, both
// as `-c` values, so nothing is written into the person's Codex config and a repository's own `.codex/` hooks stay
// untrusted. Measured on codex 0.160 (inventory §19): a hook passed with `-c hooks.PreToolUse=[...]` comes from the
// session-flags layer, and runs only when `hooks.state` names its key with the hash Codex computes; an untrusted one is
// skipped silently, which is why the Host also proves the hook ran (the session's enforce file).
import { createHash } from 'node:crypto'

const TIMEOUT = 10

/** The session-flags layer's config path(s), as the hook key's source. On Windows Codex has been seen naming it both
 *  ways (measured); elsewhere it is the one form (unmeasured: the Host's proof stops a session whose hook did not run). */
function sourcesFor(platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? ['C:\\<session-flags>\\config.toml', 'C:\\<session-flags>/config.toml'] : ['/<session-flags>/config.toml']
}

/** `v` as JSON with every object's keys in order, compact: serde_json's canonical form, which Python's
 *  `json.dumps(sort_keys=True, separators=(',', ':'), ensure_ascii=False)` matches. */
function sortedJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(sortedJson).join(',')}]`
  if (typeof v === 'object' && v !== null)
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${sortedJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(v)
}

/** The trust hash Codex checks for the one PreToolUse hook (codex-rs hooks/src/engine/discovery.rs `hook_hash`,
 *  config/src/fingerprint.rs). */
export function codexHookHash(command: string): string {
  const identity = { event_name: 'pre_tool_use', matcher: '*', hooks: [{ type: 'command', command, timeout: TIMEOUT, async: false }] }
  return `sha256:${createHash('sha256').update(sortedJson(identity), 'utf8').digest('hex')}`
}

/** `s` as a TOML basic string: a quote, a backslash and every control character escaped, the rest as it is. */
function tomlString(s: string): string {
  // eslint-disable-next-line no-control-regex
  const escaped = s.replace(/[\\"\u0000-\u001f\u007f]/g, (c) =>
    c === '\\' || c === '"' ? `\\${c}` : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
  return `"${escaped}"`
}

/**
 * The arguments that make a Codex session (terminal or `app-server`) run `command` before every tool call. The command
 * is a TOML basic string, escaped, since captureCommand's Windows form is single-quoted. `hooks.state` is one TOML
 * value, because its keys hold dots (`config.toml`) that a `-c` key path cannot (inventory §19).
 */
export function codexEnforceArgs(a: { command: string; platform: NodeJS.Platform }): string[] {
  const hash = codexHookHash(a.command)
  const state = sourcesFor(a.platform).map((src) => `'${src}:pre_tool_use:0:0'={trusted_hash="${hash}"}`)
  return [
    '-c',
    `hooks.PreToolUse=[{matcher="*",hooks=[{type="command",command=${tomlString(a.command)},timeout=${TIMEOUT}}]}]`,
    '-c',
    `hooks.state={${state.join(',')}}`
  ]
}
