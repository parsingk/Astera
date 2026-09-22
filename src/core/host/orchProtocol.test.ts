import { describe, it, expect } from 'vitest'
import { versionOnlyOrchCall } from './orchProtocol'
import { HOST_PROTOCOL } from './protocol'

describe('versionOnlyOrchCall', () => {
  it('answers version with the Host version and protocol', async () => {
    const orch = versionOnlyOrchCall({ version: '1.2.3' })
    expect(await orch.call({ cmd: 'version', args: {}, sessionId: '' })).toEqual({
      status: 200,
      body: { version: '1.2.3', protocol: HOST_PROTOCOL }
    })
  })

  // design §5 / cliOutput.ts's codeForStatus: 모르는 명령은 404(없는 id)가 아니라 501(모르는 명령) —
  // CLI 가 이 Host 보다 새 빌드라는 뜻이고, 그것이 VERSION_MISMATCH 로 옮겨진다.
  it('answers an unknown command with 501, not 404', async () => {
    const orch = versionOnlyOrchCall({ version: '1.2.3' })
    expect(await orch.call({ cmd: 'bogus', args: {}, sessionId: '' })).toEqual({
      status: 501,
      body: { error: 'unknown command: bogus' }
    })
  })
})
