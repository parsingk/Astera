// Lets a test's child `node --experimental-strip-types` run this repo's TypeScript, whose relative imports carry no
// extension: an unresolved relative import is retried with `.ts`.
import { register } from 'node:module'

register(
  'data:text/javascript,' +
    encodeURIComponent(
      'export async function resolve(s, c, n) { try { return await n(s, c) } catch (e) { if (s.startsWith(".") && !/\\.[cm]?[jt]s$/.test(s)) return n(s + ".ts", c); throw e } }'
    )
)
