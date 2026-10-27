// The sandbox probes (enforce and sandbox design §8, E4): what S2 asks of each CLI's sandbox, as POSIX shell lines run in
// a workspace that measure-sandbox.mjs prepares (a repository with a worktree whose common directory is outside it,
// fake credentials in the home, a loopback server on ASTERA_PROBE_PORT). Each line succeeds when the action it tries
// is allowed. A sandbox's result is read against the same line run with no sandbox (`verdict`).
import { spawnSync } from 'node:child_process'

const COMMIT = 'git -c user.name=p -c user.email=p@p commit -qm probe'

export const PROBES = [
  { id: 'write-workspace', line: 'echo x > ./probe-write.txt' },
  { id: 'write-tmp', line: 'echo x > "${TMPDIR:-/tmp}/astera-probe.txt"' },
  { id: 'write-home', line: 'echo x > "$HOME/astera-probe-write.txt"' },
  { id: 'read-home', line: 'cat "$HOME/astera-probe-home.txt"' },
  { id: 'read-ssh', line: 'cat "$HOME/.ssh/astera-probe-key"' },
  { id: 'read-aws', line: 'cat "$HOME/.aws/credentials"' },
  { id: 'read-gh', line: 'cat "$HOME/.config/gh/hosts.yml"' },
  { id: 'git-credential', line: "printf 'protocol=https\\nhost=astera-probe.example\\n\\n' | git credential fill" },
  {
    id: 'keychain',
    line: process.platform === 'darwin' ? 'security find-generic-password -s astera-probe -w' : 'secret-tool lookup service astera-probe'
  },
  { id: 'network', line: "curl -sS -m 15 -o /dev/null -w '%{http_code}' https://example.com" },
  { id: 'loopback', line: 'curl -sS -m 5 "http://127.0.0.1:$ASTERA_PROBE_PORT/"' },
  // Appended, so there is always a change to commit
  { id: 'git-commit', line: `echo c >> commit.txt && git add -A && ${COMMIT}` },
  // Found by the first run: on Linux srt puts /dev/null over the startup file names missing in its cwd, which
  // `git add -A` refuses, so a commit of one named file says whether committing itself is allowed
  { id: 'git-commit-named', line: `echo n >> named.txt && git add named.txt && ${COMMIT}` },
  { id: 'git-commit-worktree', line: `cd wt && echo y >> wt.txt && git add -A && ${COMMIT}` },
  { id: 'git-hooks-write', line: "printf '#!/bin/sh\\n' > .git/hooks/pre-commit" },
  { id: 'git-config-write', line: 'git config core.hooksPath /tmp/astera-probe-hooks' },
  { id: 'npm-install', line: 'npm install --no-audit --no-fund --silent is-number@7.0.0' }
]

const OUT_MAX = 400

/**
 * Runs each probe's line through `wrap` (the sandbox's command around `sh -c <line>`, or none) in `o.cwd`. `o.probes`
 * replaces PROBES, `o.only` picks some by id. A probe that does not end within `o.timeoutMs` is stopped and recorded so;
 * a program that is not there is recorded as missing.
 */
export function runProbes(wrap, o) {
  const list = (o.probes ?? PROBES).filter((p) => o.only === undefined || o.only.includes(p.id))
  return list.map((p) => {
    const { file, args } = wrap(p.line)
    const r = spawnSync(file, args, { cwd: o.cwd, env: o.env, timeout: o.timeoutMs ?? 20_000, encoding: 'utf8' })
    const missing = r.error?.code === 'ENOENT'
    const timedOut = r.error?.code === 'ETIMEDOUT'
    const code = typeof r.status === 'number' ? r.status : null
    return {
      id: p.id,
      code,
      ok: !missing && !timedOut && code === 0,
      timedOut,
      missing,
      out: `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(0, OUT_MAX)
    }
  })
}

/**
 * The probes under a sandbox that can start a command at all: `o.sanity` (a line that only succeeds, `true` by default)
 * runs first, and when it fails every probe is recorded as refused, with what the sandbox said. Found by a smoke run: a
 * sandbox that could not start `sh` read as every probe denied.
 */
export function runSet(wrap, o) {
  const [sane] = runProbes(wrap, { ...o, only: undefined, probes: [{ id: 'sanity', line: o.sanity ?? 'true' }] })
  if (sane.ok) return runProbes(wrap, o)
  const list = (o.probes ?? PROBES).filter((p) => o.only === undefined || o.only.includes(p.id))
  return list.map((p) => ({ id: p.id, code: sane.code, ok: false, timedOut: false, missing: false, refused: true, out: sane.out }))
}

/** One probe under a sandbox, read against the same probe with none. */
export function verdict(plain, sandboxed) {
  if (sandboxed.refused) return 'refused'
  if (sandboxed.missing) return 'missing'
  if (sandboxed.timedOut) return 'timeout'
  if (!plain.ok) return 'fixture-broken'
  return sandboxed.ok ? 'allowed' : 'denied'
}

/** The probes as Markdown: one row per probe run with no sandbox, one column per sandbox set. */
export function probeTable(title, plain, sets) {
  const names = Object.keys(sets)
  const rows = plain.map((p) => {
    const cells = names.map((n) => {
      const s = sets[n].find((r) => r.id === p.id)
      return s === undefined ? 'not run' : verdict(p, s)
    })
    return `| ${p.id} | ${cells.join(' | ')} |`
  })
  return [`### ${title}`, '', `| probe | ${names.join(' | ')} |`, `| --- | ${names.map(() => '---').join(' | ')} |`, ...rows, ''].join('\n')
}
