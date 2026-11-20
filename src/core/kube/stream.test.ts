import { describe, expect, it } from 'vitest'
import { streamKubectl, type KubectlStream, type StreamExit } from './stream'

const node = process.execPath

describe('streamKubectl', () => {
  it('streams stdout in chunks and reports the exit code', async () => {
    const out: string[] = []
    const exit = await new Promise<StreamExit>((done) =>
      streamKubectl(['-e', "process.stdout.write('a'); setTimeout(() => { process.stdout.write('b'); process.exit(3) }, 50)"], {
        bin: node,
        onStdout: (c) => out.push(c),
        onStderr: () => {},
        onExit: done
      })
    )
    expect(out.join('')).toBe('ab')
    expect(exit).toEqual({ code: 3, stopped: false })
  })

  it('stop kills it and says so', async () => {
    let s: KubectlStream | null = null
    const exit = await new Promise<StreamExit>((done) => {
      s = streamKubectl(['-e', 'setInterval(() => {}, 1000)'], { bin: node, onStdout: () => {}, onStderr: () => {}, onExit: done })
      setTimeout(() => s!.stop(), 100)
    })
    expect(exit.stopped).toBe(true)
  })

  it('reports a missing binary', async () => {
    const exit = await new Promise<StreamExit>((done) =>
      streamKubectl([], { bin: 'definitely-not-kubectl-xyz', onStdout: () => {}, onStderr: () => {}, onExit: done })
    )
    expect(exit).toMatchObject({ code: null, errorCode: 'ENOENT', stopped: false })
  })

  it('fires onExit once even when stop is called after the end', async () => {
    let calls = 0
    let s: KubectlStream | null = null
    await new Promise<void>((done) => {
      s = streamKubectl(['-e', 'process.exit(0)'], { bin: node, onStdout: () => {}, onStderr: () => {}, onExit: () => { calls++; done() } })
    })
    s!.stop()
    await new Promise((r) => setTimeout(r, 100))
    expect(calls).toBe(1)
  })
})
