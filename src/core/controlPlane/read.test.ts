import { describe, it, expect } from 'vitest'
import { readRuntimeReport } from './read'
import { REPORT_CAPABILITY, type ControlPlaneReport } from './report'
import { RemoteError } from '../remote/client'
import { t } from '../i18n'
import type { RemoteAnswer, RemoteLink } from '../remote/link'
import type { HelloFrame } from '../remote/frames'

const REPORT: ControlPlaneReport = {
  version: 1,
  astera: { version: '1.5.0', platform: 'darwin' },
  extensions: [{ id: 'skill-a', kind: 'skill', name: 'skill-a', enabled: true, providers: ['claude'] }],
  profiles: [],
  appBypass: false,
  policy: null,
  sandbox: { claude: { kind: 'sandbox', blocker: null }, codex: { kind: 'deny-only', blocker: null } },
  credentials: null,
  secretStore: { kind: 'owner-only-files', ok: true },
  findings: null
}

const hello = (capabilities: string[]): HelloFrame => ({
  t: 'hello', runtimeId: 'rt_a', displayName: 'Office', asteraVersion: '1.5.0', hostProtocol: 4, gatewayProtocol: 1, bootId: 'b', platform: 'darwin', pathStyle: 'posix', permission: 'read-only', capabilities
})

/** A link that answers every call with `answer`, and says `h` was its hello. */
function stub(answer: RemoteAnswer | RemoteError, h: HelloFrame | null = hello([REPORT_CAPABILITY])) {
  const calls: string[] = []
  const link: RemoteLink = {
    hello: () => h,
    call: async (cmd) => {
      calls.push(cmd)
      return answer
    },
    subscribe: () => () => {},
    close: () => {}
  }
  return { link, calls }
}

describe('readRuntimeReport (remote governance design §5.1, §5.3)', () => {
  it('a report is parsed', async () => {
    const s = stub({ status: 200, body: { ...REPORT, path: '/home/me' } })
    expect(await readRuntimeReport(s.link)).toEqual({ ok: true, report: REPORT })
    expect(s.calls).toEqual(['control-plane-report'])
  })

  // Review Focus 1: an older Runtime gets "update Astera there", never a bare refusal
  it("an older Runtime's refusal says to update Astera there", async () => {
    const s = stub({ status: 501, body: { error: 'unknown command control-plane-report' } }, hello([]))
    expect(await readRuntimeReport(s.link)).toEqual({
      ok: false,
      code: 'RUNTIME_CAPABILITY_MISSING',
      message: 'this Runtime cannot report its setup; update Astera there'
    })
  })

  it('a person-only refusal is passed through with its code', async () => {
    const s = stub({ status: 403, body: { error: 'control-plane-report answers a person on another computer', code: 'RUNTIME_PERMISSION_DENIED' } })
    expect(await readRuntimeReport(s.link)).toEqual({
      ok: false,
      code: 'RUNTIME_PERMISSION_DENIED',
      message: 'control-plane-report answers a person on another computer'
    })
  })

  it('an offline link gives RUNTIME_OFFLINE', async () => {
    const s = stub(new RemoteError('RUNTIME_OFFLINE', 'connect ECONNREFUSED'), null)
    expect(await readRuntimeReport(s.link)).toEqual({ ok: false, code: 'RUNTIME_OFFLINE', message: 'connect ECONNREFUSED' })
  })

  it('a report the parser refuses is FAILED and never kept', async () => {
    for (const version of [0, '2', undefined]) {
      const s = stub({ status: 200, body: { ...REPORT, version } })
      const r = await readRuntimeReport(s.link)
      expect(r).toEqual({ ok: false, code: 'FAILED', message: 'the Runtime sent a report this computer cannot read: the report is not version 1' })
      expect('report' in r).toBe(false)
    }
  })

  // Final review F8: a report newer than this build reads is this computer's to catch up with
  it('a report whose version is above 1 is FAILED, says to update Astera on this computer, and is never kept', async () => {
    for (const body of [{ ...REPORT, version: 2 }, { version: 3, somethingNew: true }]) {
      const r = await readRuntimeReport(stub({ status: 200, body }).link)
      expect(r).toEqual({ ok: false, code: 'FAILED', message: t('en', 'settings.remote.detail.reportNewer'), reason: 'report-newer' })
      expect((r as { message: string }).message).toContain('Update Astera on this computer')
    }
  })
})
