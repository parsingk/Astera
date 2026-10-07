// Runs a `*.child.ts` file in a real second process, for the tests that need two processes racing on one lock
// (remote runtime design §4.6, X1-12). `testChild.mjs` lets Node's type stripping resolve this repo's extensionless
// relative imports.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const runChild = (script: string, args: string[]): Promise<{ code: number; out: string }> =>
  new Promise((resolve) => {
    let out = ''
    const c = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', pathToFileURL(path.join(__dirname, 'testChild.mjs')).href, script, ...args], {
      stdio: ['ignore', 'pipe', 'inherit']
    })
    c.stdout.on('data', (d: Buffer) => (out += d.toString()))
    c.on('exit', (code) => resolve({ code: code ?? 1, out: out.trim() }))
  })
