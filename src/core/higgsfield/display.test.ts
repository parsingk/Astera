import { describe, it, expect } from 'vitest'
import { hfAccountTitle, hfWorkspaceLabel } from './display'

describe('hfAccountTitle', () => {
  it('shows label and email, or the label once when they are the same', () => {
    expect(hfAccountTitle('Main', 'a@x.com')).toBe('Main · a@x.com')
    expect(hfAccountTitle('A@x.com', 'a@X.com')).toBe('A@x.com')
    expect(hfAccountTitle(' a@x.com ', 'a@x.com')).toBe(' a@x.com ')
    expect(hfAccountTitle('Main', undefined)).toBe('Main')
    expect(hfAccountTitle('Main', '')).toBe('Main')
  })
})

describe('hfWorkspaceLabel', () => {
  it('names a workspace by name, else plan, else the id prefix, with its credits', () => {
    const id = 'aaaaaaaa-1111-4111-8111-111111111111'
    expect(hfWorkspaceLabel({ id, name: 'Team', plan: 'pro', credits: 7 }, (n) => `${n} cr`)).toBe('Team · 7 cr')
    expect(hfWorkspaceLabel({ id, name: null, plan: 'pro', credits: null }, (n) => `${n} cr`)).toBe('pro')
    expect(hfWorkspaceLabel({ id, name: null, plan: null, credits: 0 }, (n) => `${n} cr`)).toBe('aaaaaaaa · 0 cr')
  })
})
