import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { approvalMessage, configureArgs, configureStdinError, doctorEnd, installPlugin } from './plugins'
import { PLUGIN_DECLARATIVE_NOTICE, PLUGIN_RESTRICTED_UI_NOTICE, PLUGIN_TRUST_WARNING } from '../core/plugins/manifest'

const INSPECTION = {
  id: '@acme/astera-jira',
  name: '@acme/astera-jira',
  displayName: 'Jira',
  version: '1.0.0',
  apiVersion: '1',
  entry: './dist/plugin.js',
  capabilities: [],
  permissions: ['jobs.read', 'jobs.create'],
  compatible: true
}

/** A Host that answers inspect with `inspection` and records every call. */
const host = (inspection: { status: number; body: unknown } = { status: 200, body: INSPECTION }) => {
  const calls: { cmd: string; args: Record<string, unknown>; request: string | undefined }[] = []
  const call = async (cmd: string, args: Record<string, unknown>, request: string | undefined) => {
    calls.push({ cmd, args, request })
    return cmd === 'plugins-inspect' ? inspection : { status: 200, body: { id: '@acme/astera-jira', installed: true } }
  }
  return { calls, call }
}

const CWD = path.resolve('/work/plugins')

describe('installPlugin', () => {
  it('resolves --path against the shell’s folder and asks for approval without --yes or --grant, installing nothing', async () => {
    const h = host()
    const r = await installPlugin({ args: { path: 'jira' }, cwd: CWD, request: 'req-1', call: h.call })
    expect(r).toEqual({ approve: INSPECTION })
    expect(h.calls).toEqual([{ cmd: 'plugins-inspect', args: { path: path.join(CWD, 'jira') }, request: undefined }])
  })

  it('grants what the plugin asks for with --yes, pinning what it showed, under the request id', async () => {
    const h = host()
    const r = await installPlugin({ args: { path: 'jira', yes: true }, cwd: CWD, request: 'req-1', call: h.call })
    expect(r).toEqual({ status: 200, body: { id: '@acme/astera-jira', installed: true } })
    expect(h.calls[1]).toEqual({
      cmd: 'plugins-install',
      args: { path: path.join(CWD, 'jira'), grant: ['jobs.read', 'jobs.create'], expect: { name: '@acme/astera-jira', version: '1.0.0' } },
      request: 'req-1'
    })
  })

  it('grants exactly the --grant list, trimmed, and it wins over --yes', async () => {
    const h = host()
    await installPlugin({ args: { path: '/abs/jira', grant: 'jobs.read, jobs.create,', yes: true }, cwd: CWD, request: undefined, call: h.call })
    expect(h.calls[1].args.grant).toEqual(['jobs.read', 'jobs.create'])
    expect(h.calls[1].args.path).toBe(path.resolve('/abs/jira'))
  })

  it('takes an empty --grant as granting nothing', async () => {
    const h = host()
    await installPlugin({ args: { path: 'jira', grant: '' }, cwd: CWD, request: undefined, call: h.call })
    expect(h.calls[1].args.grant).toEqual([])
  })

  it('hands back an inspection the Host refused, and an answer that never came', async () => {
    const refused = host({ status: 400, body: { error: 'no package.json in /work/plugins/jira' } })
    expect(await installPlugin({ args: { path: 'jira', yes: true }, cwd: CWD, request: undefined, call: refused.call })).toEqual({
      status: 400,
      body: { error: 'no package.json in /work/plugins/jira' }
    })
    expect(refused.calls).toHaveLength(1)
    const gone = { calls: 0, call: async () => ({ unreachable: 'no Host' }) }
    expect(await installPlugin({ args: { path: 'jira', yes: true }, cwd: CWD, request: undefined, call: gone.call })).toEqual({ unreachable: 'no Host' })
  })

  // Final review m4: the parser reads a bare --grant as true, which must not fall through to --yes's grant-everything.
  it('refuses a --grant with no list, pointing to the empty one', async () => {
    const h = host()
    expect(await installPlugin({ args: { path: 'jira', grant: true, yes: true }, cwd: CWD, request: undefined, call: h.call })).toEqual({
      status: 400,
      body: { error: '--grant needs a list of permissions; --grant "" grants none' }
    })
    expect(h.calls).toEqual([])
  })

  it('refuses a missing source, or both, before asking the Host', async () => {
    const h = host()
    expect(await installPlugin({ args: { yes: true }, cwd: CWD, request: undefined, call: h.call })).toEqual({
      status: 400,
      body: { error: 'plugins install needs --path <folder>, --npm <package> or --file <package.tgz>' }
    })
    expect(await installPlugin({ args: { path: 'jira', npm: '@acme/astera-jira', yes: true }, cwd: CWD, request: undefined, call: h.call })).toEqual({
      status: 400,
      body: { error: 'plugins install takes one of --path, --npm and --file' }
    })
    expect(await installPlugin({ args: { path: 'jira', file: 'jira.tgz', yes: true }, cwd: CWD, request: undefined, call: h.call })).toEqual({
      status: 400,
      body: { error: 'plugins install takes one of --path, --npm and --file' }
    })
    expect(h.calls).toEqual([])
  })

  // Phase 2 step 4a: a package `plugins pack` made, by its file, resolved against the shell's folder; the sha256 shown is
  // the one installed
  it('inspects and installs a package file, pinning the sha256 it showed', async () => {
    const h = host({ status: 200, body: { ...INSPECTION, trust: 'trusted', source: { file: path.join(CWD, 'jira.tgz'), sha256: 'ab12' } } })
    const r = await installPlugin({ args: { file: 'jira.tgz', yes: true }, cwd: CWD, request: 'req-1', call: h.call })
    expect(r).toEqual({ status: 200, body: { id: '@acme/astera-jira', installed: true } })
    expect(h.calls).toEqual([
      { cmd: 'plugins-inspect', args: { file: path.join(CWD, 'jira.tgz') }, request: undefined },
      {
        cmd: 'plugins-install',
        args: { file: path.join(CWD, 'jira.tgz'), grant: ['jobs.read', 'jobs.create'], expect: { name: '@acme/astera-jira', version: '1.0.0', trust: 'trusted', sha256: 'ab12' } },
        request: 'req-1'
      }
    ])
  })

  // Plugins 2e (spec §12): a plugin published on npm, inspected and approved as a folder is.
  it('inspects and installs an npm package by the spec as given, pinning the version it showed', async () => {
    const h = host()
    const r = await installPlugin({ args: { npm: '@acme/astera-jira@^1.0.0', yes: true }, cwd: CWD, request: 'req-1', call: h.call })
    expect(r).toEqual({ status: 200, body: { id: '@acme/astera-jira', installed: true } })
    expect(h.calls).toEqual([
      { cmd: 'plugins-inspect', args: { npm: '@acme/astera-jira@^1.0.0' }, request: undefined },
      {
        cmd: 'plugins-install',
        args: { npm: '@acme/astera-jira@^1.0.0', grant: ['jobs.read', 'jobs.create'], expect: { name: '@acme/astera-jira', version: '1.0.0' } },
        request: 'req-1'
      }
    ])
    expect(await installPlugin({ args: { npm: '@acme/astera-jira' }, cwd: CWD, request: undefined, call: host().call })).toEqual({ approve: INSPECTION })
  })
})

describe('approvalMessage', () => {
  // Final review m8: a package file is approved by what it is: the file and the sha256 of the bytes that will install
  it('names the package file and its sha256', () => {
    const m = approvalMessage({ ...INSPECTION, source: { file: '/w/jira-1.0.0.tgz', sha256: 'ab12' } })
    expect(m).toContain('From /w/jira-1.0.0.tgz, sha256 ab12.')
  })

  it('says what the plugin is and asks for, that it is trusted code, and how to approve', () => {
    expect(approvalMessage(INSPECTION)).toBe(
      `Jira 1.0.0 (@acme/astera-jira) asks for: jobs.read, jobs.create. ${PLUGIN_TRUST_WARNING} Approve with --yes, or name what to grant with --grant <list>.`
    )
  })
  // Final review m7: an update says what it replaces.
  it('says what an install replaces', () => {
    expect(approvalMessage({ ...INSPECTION, installed: { version: '0.9.0', enabled: false } })).toBe(
      `Jira 1.0.0 (@acme/astera-jira) asks for: jobs.read, jobs.create. It replaces the installed 0.9.0. ${PLUGIN_TRUST_WARNING} Approve with --yes, or name what to grant with --grant <list>.`
    )
  })

  // Final review m6: inside an agent session the approval is refused, so the message says who can give it.
  it('tells an agent session that a person installs it', () => {
    expect(approvalMessage(INSPECTION, { agent: true })).toBe(
      `Jira 1.0.0 (@acme/astera-jira) asks for: jobs.read, jobs.create. ${PLUGIN_TRUST_WARNING} Installing it is for a person at their own shell or in the Astera app, not an agent session (ASTERA_SESSION is set): ask them to run astera plugins install with --yes.`
    )
  })

  it('says when it asks for nothing, and when it will not run here', () => {
    expect(approvalMessage({ ...INSPECTION, permissions: [], compatible: false, reason: 'this Astera does not run event plugins yet' })).toBe(
      `Jira 1.0.0 (@acme/astera-jira) asks for: no permissions. ${PLUGIN_TRUST_WARNING} It will not run here: this Astera does not run event plugins yet. Approve with --yes, or name what to grant with --grant <list>.`
    )
  })
})

// Final review m7: what the install exits with before approval is a contract scripts read, so the guide and the usage
// table say it.
describe('the docs say what an unapproved install exits with', () => {
  it('in docs/cli.md and in the usage table', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { USAGE } = await import('../core/orchestration/cliUsage')
    const docs = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs/cli.md'), 'utf8')
    const section = docs.slice(docs.indexOf('### Plugins'), docs.indexOf('## Command reference')).replace(/\s+/g, ' ')
    expect(section).toContain('Without --yes or --grant, `install` installs nothing and exits 2')
    expect(section).toContain('inside an agent session (`ASTERA_SESSION` is set) the changes are refused with exit 5')
    expect(USAGE['plugins-install'].detail).toContain('Exits 2 until you approve')
  })
})

describe('doctorEnd', () => {
  it('ends a doctor that found a problem with FAILED, naming each failing check', () => {
    const body = {
      id: 'astera-hello',
      ok: false,
      checks: [
        { name: 'manifest', ok: true, detail: 'fine' },
        { name: 'native-addons', ok: false, detail: '1 native addon (a.node)' },
        { name: 'runtime', ok: false, detail: 'failed: activate threw: x' }
      ]
    }
    expect(doctorEnd(body)).toEqual({
      code: 'FAILED',
      message: 'astera-hello has problems: native-addons: 1 native addon (a.node); runtime: failed: activate threw: x',
      details: body
    })
    expect(doctorEnd({ id: 'astera-hello', ok: true, checks: [] })).toBeNull()
  })
})

// 2b final review M3: the guide said 1, 2 and 5 seconds, and the third wait never came. The waits it states are the
// runtime's own, and the runtime has no wait the crash count never reaches.
describe('the docs say how a crashing plugin is restarted', () => {
  it('with the waits and the count the runtime uses', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { PLUGIN_TIMINGS } = await import('../host/plugins/runtime')
    expect(PLUGIN_TIMINGS.backoffMs).toHaveLength(PLUGIN_TIMINGS.failAfter - 1)
    const docs = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs/cli.md'), 'utf8')
    const section = docs.slice(docs.indexOf('### Plugins'), docs.indexOf('## Command reference')).replace(/\s+/g, ' ')
    const waits = PLUGIN_TIMINGS.backoffMs.map((ms) => String(ms / 1000))
    expect(section).toContain(`A plugin that crashes is started again after ${waits.slice(0, -1).join(', ')}, then ${waits.at(-1)} seconds`)
    expect(section).toContain(`the ${['first', 'second', 'third', 'fourth'][PLUGIN_TIMINGS.failAfter - 1]} crash without ${PLUGIN_TIMINGS.stableMs / 1000} seconds of steady running`)
  })

  // 2c final review M14: what configure does not do for a failed plugin, and which values the log does not hide.
  it('with what configure leaves to plugins enable, and the shortest value the log hides', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { REDACT_MIN } = await import('../host/plugins/runtime')
    const docs = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs/cli.md'), 'utf8')
    const section = docs.slice(docs.indexOf('### Plugins'), docs.indexOf('## Command reference')).replace(/\s+/g, ' ')
    expect(section).toContain('a plugin that `failed` stays stopped after `plugins configure` until `plugins enable` starts it again')
    expect(section).toContain(`a value shorter than ${REDACT_MIN} characters is not hidden`)
  })
})

// Plugins 2c: `--set key=value`, `--unset key` and `--stdin key` as the Host's { set, unset }.
describe('configureArgs', () => {
  it('turns the flags into what the Host takes, splitting at the first =', () => {
    expect(configureArgs({ id: 'x', set: ['baseUrl=https://a.example.com/?q=1', 'pageSize=25'], unset: ['project'] }, undefined)).toEqual({
      args: { id: 'x', set: { baseUrl: 'https://a.example.com/?q=1', pageSize: '25' }, unset: ['project'] }
    })
  })

  it('sets the --stdin key from standard input, one trailing newline dropped, so a secret stays off the command line', () => {
    const lf = String.fromCharCode(10)
    expect(configureArgs({ id: 'x', stdin: 'token' }, `tok-1${lf}`)).toEqual({ args: { id: 'x', set: { token: 'tok-1' } } })
    expect(configureArgs({ id: 'x', stdin: 'token', set: ['a=b'] }, `tok-1${lf}${lf}`)).toEqual({ args: { id: 'x', set: { a: 'b', token: `tok-1${lf}` } } })
  })

  it('refuses a --set without =, an empty key, a --stdin with nothing on standard input, and a key given twice', () => {
    // Never the text itself (2c final review I5): a --set without = may be a secret typed without its key.
    expect(configureArgs({ id: 'x', set: ['tok-secret-1'] }, undefined)).toEqual({ error: '--set needs key=value, and one has no =' })
    expect(configureArgs({ id: 'x', set: ['=tok-secret-1'] }, undefined)).toEqual({ error: '--set needs key=value, and one has no key before its =' })
    expect(configureArgs({ id: 'x', stdin: 'token' }, '')).toEqual({ error: '--stdin token read nothing from standard input' })
    expect(configureArgs({ id: 'x', stdin: true }, 'v')).toEqual({ error: '--stdin needs the key to set' })
    expect(configureArgs({ id: 'x', set: ['a=1', 'a=2'] }, undefined)).toEqual({ error: 'a is set twice' })
    expect(configureArgs({ id: 'x', set: ['a=1'], stdin: 'a' }, 'v')).toEqual({ error: 'a is set twice' })
  })

  // 2c final review I5: `--stdin -` read standard input twice and set nothing at exit 0, and `--set -` echoed it.
  it('refuses a - for any of its flags, before standard input is read, pointing to --stdin <key>', () => {
    expect(configureStdinError([])).toBeNull()
    expect(configureStdinError(['stdin'])).toBe(
      'plugins configure reads standard input only as --stdin <key>, as in --stdin token; a - after --stdin is not one'
    )
    expect(configureStdinError(['set', 'unset'])).toBe(
      'plugins configure reads standard input only as --stdin <key>, as in --stdin token; a - after --set or --unset is not one'
    )
  })
})

// Plugin API 2 (ADR-008): a UI-only plugin is restricted UI, and is never introduced as trusted code
describe('approvalMessage by trust level', () => {
  it('gives a UI-only plugin the restricted UI notice instead of the trusted code warning', () => {
    const m = approvalMessage({ ...INSPECTION, trust: 'restricted-ui', permissions: ['panels.register'] })
    expect(m).toBe(
      `Jira 1.0.0 (@acme/astera-jira) asks for: panels.register. ${PLUGIN_RESTRICTED_UI_NOTICE} Approve with --yes, or name what to grant with --grant <list>.`
    )
    expect(m).not.toContain(PLUGIN_TRUST_WARNING)
  })

  // Phase 2 remaining: a themes-only plugin runs no code and shows no page
  it('gives a declarative plugin its own notice, neither the restricted UI notice nor the trusted code warning', () => {
    const m = approvalMessage({ ...INSPECTION, trust: 'declarative', permissions: ['themes.register'] })
    expect(m).toContain(PLUGIN_DECLARATIVE_NOTICE)
    expect(m).not.toContain(PLUGIN_RESTRICTED_UI_NOTICE)
    expect(m).not.toContain(PLUGIN_TRUST_WARNING)
  })

  it('keeps the trusted code warning for a plugin with a host entry, and for one that does not say', () => {
    expect(approvalMessage({ ...INSPECTION, trust: 'trusted' })).toContain(PLUGIN_TRUST_WARNING)
    expect(approvalMessage(INSPECTION)).toContain(PLUGIN_TRUST_WARNING)
  })
})

// Final review M7: the trust level shown travels with the install
describe('installPlugin sends the trust level it showed', () => {
  it('names it in expect when the inspection had one', async () => {
    const calls: { cmd: string; args: unknown }[] = []
    const call = async (cmd: string, args: unknown): Promise<{ status: number; body: unknown }> => {
      calls.push({ cmd, args })
      return cmd === 'plugins-inspect'
        ? { status: 200, body: { ...INSPECTION, trust: 'restricted-ui', permissions: ['panels.register'] } }
        : { status: 200, body: {} }
    }
    await installPlugin({ args: { path: 'hello', yes: true }, cwd: CWD, request: undefined, call })
    const install = calls.find((c) => c.cmd === 'plugins-install')
    expect((install?.args as { expect: unknown }).expect).toEqual({ name: '@acme/astera-jira', version: '1.0.0', trust: 'restricted-ui' })
  })
})

// Final review of plugins dev, I5: a reinstall carries the approval dev holds, never what a later inspection showed
describe('installPlugin with an approval held', () => {
  it('refuses, installing nothing, a folder that now asks for something other than what was approved', async () => {
    const h = host({ status: 200, body: { ...INSPECTION, trust: 'trusted' } })
    const r = await installPlugin({ args: { path: 'jira', grant: 'jobs.read' }, cwd: CWD, request: undefined, call: h.call, approved: { trust: 'restricted-ui', permissions: ['jobs.read', 'jobs.create'], capabilities: [] } })
    expect(r).toMatchObject({ status: 409, body: { error: expect.stringMatching(/asks for something other than what was approved/) } })
    expect(h.calls.map((c) => c.cmd)).toEqual(['plugins-inspect'])
  })

  it('sends the approved trust as what the Host must find', async () => {
    const h = host({ status: 200, body: { ...INSPECTION, trust: 'trusted' } })
    await installPlugin({ args: { path: 'jira', grant: 'jobs.read' }, cwd: CWD, request: undefined, call: h.call, approved: { trust: 'trusted', permissions: ['jobs.read', 'jobs.create'], capabilities: [] } })
    expect(h.calls[1]).toMatchObject({ cmd: 'plugins-install', args: { expect: { trust: 'trusted' } } })
  })
})
