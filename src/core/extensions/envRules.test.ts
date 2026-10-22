// Agent Control Plane release 2 (Gateway design §4.6): a shared server's values reach only its own process now, so the
// environment-name rules that guarded the session's environment are gone; what is left is the default for "keep as
// a secret" in the import dialog.
import { describe, it, expect } from 'vitest'
import { looksSecret } from './envRules'

describe('looksSecret', () => {
  it('takes credential-looking names as secret by default', () => {
    for (const n of ['GITHUB_TOKEN', 'LINEAR_API_KEY', 'DB_PASSWORD', 'AWS_SECRET_ACCESS_KEY', 'GOOGLE_CREDENTIALS']) expect(looksSecret(n)).toBe(true)
    for (const n of ['LOG_LEVEL', 'PORT', 'NODE_ENV']) expect(looksSecret(n)).toBe(false)
  })
})
