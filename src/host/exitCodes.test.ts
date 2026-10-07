import { describe, it, expect } from 'vitest'
import { HOST_EXIT, listenExitCode } from './exitCodes'
import { ADDRESS_TAKEN } from './server'

// A supervisor (`astera runtime serve`, remote runtime design §2.9) restarts a Host that failed, and must
// not restart one that only lost the bind race to a Host already serving the profile.
describe('Host exit codes', () => {
  it('leaves with 0 when another Host already serves the profile', () => {
    expect(listenExitCode(new Error(ADDRESS_TAKEN))).toBe(0)
  })
  it('leaves with 3 for any other listen failure', () => {
    expect(listenExitCode(Object.assign(new Error('listen EACCES'), { code: 'EACCES' }))).toBe(3)
    expect(listenExitCode('not even an error')).toBe(3)
  })
  it('keeps 2 for the Host key and gives a missing profile its own 4', () => {
    expect(HOST_EXIT.keyFailure).toBe(2)
    expect(HOST_EXIT.noProfile).toBe(4)
  })
})
