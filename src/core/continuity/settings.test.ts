import { describe, it, expect } from 'vitest'
import { applyContinuityToggle } from './settings'

describe('applyContinuityToggle', () => {
  it('turning on with Smart Resume off turns Smart Resume on and says so (spec 3.2)', () => {
    expect(applyContinuityToggle({ jobContinuity: false, resumeStrategy: 'original' }, true)).toEqual({
      jobContinuity: true,
      resumeStrategy: 'smart',
      smartResumeTurnedOn: true
    })
  })

  it('turning on with Smart Resume already on changes nothing else', () => {
    expect(applyContinuityToggle({ jobContinuity: false, resumeStrategy: 'smart' }, true)).toEqual({
      jobContinuity: true,
      resumeStrategy: 'smart',
      smartResumeTurnedOn: false
    })
  })

  it('turning off never touches Smart Resume (spec 3.4)', () => {
    expect(applyContinuityToggle({ jobContinuity: true, resumeStrategy: 'smart' }, false)).toEqual({
      jobContinuity: false,
      resumeStrategy: 'smart',
      smartResumeTurnedOn: false
    })
    expect(applyContinuityToggle({ jobContinuity: true, resumeStrategy: 'original' }, false)).toEqual({
      jobContinuity: false,
      resumeStrategy: 'original',
      smartResumeTurnedOn: false
    })
  })

  it('repeating the current value is a no-op', () => {
    expect(applyContinuityToggle({ jobContinuity: true, resumeStrategy: 'smart' }, true)).toEqual({
      jobContinuity: true,
      resumeStrategy: 'smart',
      smartResumeTurnedOn: false
    })
    expect(applyContinuityToggle({ jobContinuity: false, resumeStrategy: 'original' }, false)).toEqual({
      jobContinuity: false,
      resumeStrategy: 'original',
      smartResumeTurnedOn: false
    })
  })
})
