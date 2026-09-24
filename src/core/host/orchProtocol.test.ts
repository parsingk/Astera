import { describe, it, expect } from 'vitest'
import { leftNothingBehind, refusedBeforeActing, undoneBeforeFailing, versionOnlyOrchCall, wasRefusedBeforeActing } from './orchProtocol'
import { RepairNeeded } from '../settings/repairNeeded'
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

// Follow-up round m1: an error can be shared by concurrent calls (a `once()` setup promise hands every
// waiter the same rejection), so a tag goes on a copy for this call and never on the shared object.
describe('refusedBeforeActing and undoneBeforeFailing', () => {
  it('tag a copy that keeps the class, the message, the fields and the cause, and leave the original alone', () => {
    const cause = new Error('root')
    const shared = new RepairNeeded('app-settings.json is damaged', 'app-settings.json')
    Object.defineProperty(shared, 'cause', { value: cause, configurable: true, writable: true })
    for (const [tag, read] of [
      [refusedBeforeActing, wasRefusedBeforeActing],
      [undoneBeforeFailing, leftNothingBehind]
    ] as const) {
      const mine = tag(shared)
      expect(mine).not.toBe(shared)
      expect(read(mine)).toBe(true)
      expect(leftNothingBehind(shared)).toBe(false)
      expect(mine).toBeInstanceOf(RepairNeeded)
      expect(mine.message).toBe(shared.message)
      expect(mine.file).toBe('app-settings.json')
      expect(mine.stack).toBe(shared.stack)
      expect((mine as Error & { cause?: unknown }).cause).toBe(cause)
      expect(String(mine)).toBe(String(shared))
    }
  })
})
