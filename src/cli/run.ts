// astera CLI logic.
// index.ts (the bundle entry point, out/main/cli.js) executes immediately at the top level and so
// cannot be tested — that is why the side-effect-free functions and main() were pulled in here.
// main() does not call itself inside this file, so importing this module (as the tests do) does not
// terminate the process.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from '../core/orchestration/cliArgs'
import { DEFAULT_ASK_TIMEOUT_MS, DEFAULT_CHECK_TIMEOUT_MS } from '../core/orchestration/types'

export function errorOutput(msg: string): string {
  return JSON.stringify({ error: msg })
}

/** 0 if the server answered 2xx, otherwise 1. A timeout response from ask --wait is also 200 —
 *  this design's contract is that a timeout is information, not an error (section 4.7 of the
 *  orchestration guide). */
export function exitCodeFor(status: number): number {
  return status >= 200 && status < 300 ? 0 : 1
}

export function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : text + '\n'
}

/** Fills the wantsStdin keys parseArgs collected (the flags whose value was '-') with the stdin
 *  text. The original args are not mutated (the same state-spread convention as server.ts). */
export function applyStdin(a: {
  args: Record<string, unknown>
  keys: string[]
  text: string
}): Record<string, unknown> {
  const next = { ...a.args }
  for (const key of a.keys) next[key] = a.text
  return next
}

/** Headroom stacked on top of the server's long-poll deadline so the client never hangs up before
 *  the server does. It absorbs the polling interval (POLL_MS) and event-loop delay the server takes
 *  to send its response once the deadline is reached — with headroom narrower than the server's
 *  deadline, the client's AbortController cuts the connection while the server is still preparing
 *  its response, and the contract that a timeout is information rather than an error breaks (this
 *  was the defect where ask's default was shorter than the server's default). */
const TIMEOUT_HEADROOM_MS = 30_000

/** ask and check --wait are long-polled by the server, so the per-command default deadline has to
 *  come from the same constants the server uses (core/orchestration/types.ts) — split into two
 *  copies, the values drift apart. Other commands do not long-poll, so their default is effectively
 *  unused and they reuse check's value (there is no reason to add another constant). If
 *  --timeout-ms was given, that value is used as is. */
export function clientTimeoutMs(a: { cmd: string; args: Record<string, unknown> }): number {
  const defaultForCmd =
    a.cmd === 'ask' ? DEFAULT_ASK_TIMEOUT_MS : DEFAULT_CHECK_TIMEOUT_MS
  const base = typeof a.args.timeoutMs === 'number' ? a.args.timeoutMs : defaultForCmd
  return base + TIMEOUT_HEADROOM_MS
}

export function buildRequest(a: {
  port: number
  token: string
  sessionId: string
  cmd: string
  args: Record<string, unknown>
  /** The CLI process's own process.cwd(). Used only to fill run-create's --cwd default (see below) */
  cwd: string
}): { url: string; init: { method: string; headers: Record<string, string>; body: string } } {
  // run-create in server.ts fills a missing --cwd with process.cwd(), but that is evaluated in the
  // Electron main process and has nothing to do with the CLI process's working directory — omit it
  // and the Run's cwd becomes the app's own working directory (arbitrary in a packaged app), and
  // every worker of that Run (--worktree current being the default) comes up in the wrong place.
  // Only when --cwd was not given explicitly is it filled here with the CLI's own cwd (a.cwd) — an
  // explicit value always wins.
  const hasExplicitCwd = typeof a.args.cwd === 'string' && a.args.cwd.length > 0
  const args = a.cmd === 'run-create' && !hasExplicitCwd ? { ...a.args, cwd: a.cwd } : a.args
  return {
    url: `http://127.0.0.1:${a.port}/`,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${a.token}`,
        'x-astera-session': a.sessionId
      },
      body: JSON.stringify({ cmd: a.cmd, args })
    }
  }
}

/** Absolute location of the guide document. Now that the CLI moved into a bundle artifact
 *  (out/main/cli.js), a relative path to resources/skills can no longer be fixed — __dirname points
 *  somewhere different in a packaged app than in dev mode. So it is not hardcoded but taken from the
 *  ASTERA_SKILLS environment variable the wiring injects (or the --skills-dir argument that
 *  overrides it). */
export function resolveGuidePath(a: {
  args: Record<string, unknown>
  env: NodeJS.ProcessEnv
}): { ok: true; path: string } | { ok: false; error: string } {
  const dir =
    typeof a.args.skillsDir === 'string' && a.args.skillsDir.length > 0
      ? a.args.skillsDir
      : a.env.ASTERA_SKILLS
  if (!dir)
    return {
      ok: false,
      error:
        'ASTERA_SKILLS is not set (and no --skills-dir given) — is this session started by the app?'
    }
  return { ok: true, path: path.join(dir, 'orchestration-guide.md') }
}

export function readGuide(
  guidePath: string
): { ok: true; content: string } | { ok: false; error: string } {
  try {
    return { ok: true, content: readFileSync(guidePath, 'utf8') }
  } catch {
    return { ok: false, error: `cannot read ${guidePath} — is resources/skills packaged?` }
  }
}

export function readInfo(
  infoPath: string
): { ok: true; info: { port: number; token: string } } | { ok: false; error: string } {
  try {
    const info = JSON.parse(readFileSync(infoPath, 'utf8')) as { port: number; token: string }
    return { ok: true, info }
  } catch {
    return {
      ok: false,
      error: `cannot read ${infoPath} — is the app running with orchestration enabled?`
    }
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('')
    const chunks: Buffer[] = []
    process.stdin.on('data', (c: Buffer) => chunks.push(c))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

function out(text: string): void {
  process.stdout.write(ensureTrailingNewline(text))
}

/** The function the thin shell of the entry point (index.ts) calls straight through. It does not
 *  call itself here, so a test that imports this file does not terminate the process. */
export async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2))
  if ('error' in parsed) {
    out(errorOutput(parsed.error))
    process.exit(2)
  }

  // help has to work without a server connection — handle it before reading ASTERA_INFO.
  if (parsed.cmd === 'help') {
    const resolved = resolveGuidePath({ args: parsed.args, env: process.env })
    if (!resolved.ok) {
      out(errorOutput(resolved.error))
      process.exit(1)
    }
    const guide = readGuide(resolved.path)
    if (!guide.ok) {
      out(errorOutput(guide.error))
      process.exit(1)
    }
    out(guide.content)
    process.exit(0)
  }

  const infoPath = process.env.ASTERA_INFO
  const sessionId = process.env.ASTERA_SESSION ?? ''
  if (!infoPath) {
    out(errorOutput('ASTERA_INFO is not set — is this session started by the app?'))
    process.exit(1)
  }
  const info = readInfo(infoPath)
  if (!info.ok) {
    out(errorOutput(info.error))
    process.exit(1)
  }

  let args = parsed.args
  if (parsed.wantsStdin.length > 0) {
    const text = await readStdin()
    args = applyStdin({ args, keys: parsed.wantsStdin, text })
  }

  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), clientTimeoutMs({ cmd: parsed.cmd, args }))
  try {
    const { url, init } = buildRequest({
      port: info.info.port,
      token: info.info.token,
      sessionId,
      cmd: parsed.cmd,
      args,
      cwd: process.cwd()
    })
    const res = await fetch(url, { ...init, signal: ctl.signal })
    const body = await res.text()
    out(body)
    process.exit(exitCodeFor(res.status))
  } catch (e) {
    out(errorOutput(`request failed: ${String(e)}`))
    process.exit(1)
  } finally {
    clearTimeout(timer)
  }
}
