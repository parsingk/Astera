import { describe, it, expect } from 'vitest'
import { agentOpenTarget } from './urls'

describe('agentOpenTarget', () => {
  it.each([
    ['http://localhost:5173/', 'http://localhost:5173/'],
    ['http://127.0.0.1:3000/app', 'http://127.0.0.1:3000/app'],
    ['http://[::1]:8080/', 'http://[::1]:8080/'],
    ['https://app.localhost/', 'https://app.localhost/'],
    ['http://0.0.0.0:8080/', 'http://localhost:8080/'],
    ['http://[::]:8080/x', 'http://localhost:8080/x']
  ])('%s → %s', (input, expected) => {
    expect(agentOpenTarget(input)).toBe(expected)
  })

  it.each(['https://example.com/', 'http://192.168.1.10:3000/', 'file:///C:/x.html', 'javascript:alert(1)', 'nope', ''])(
    'refuses %s',
    (input) => expect(agentOpenTarget(input)).toBeNull()
  )
})
