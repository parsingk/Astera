import * as pty from 'node-pty'
import type { PtyFactory } from './pty'

export const nodePtyFactory: PtyFactory = (file, args, opts) => {
  const p = pty.spawn(file, args, { name: 'xterm-256color', ...opts })
  return {
    pid: p.pid,
    onData: (cb) => {
      p.onData(cb)
    },
    onExit: (cb) => {
      p.onExit(cb)
    },
    write: (d) => p.write(d),
    resize: (c, r) => p.resize(c, r),
    kill: () => p.kill(),
    pause: () => p.pause(),
    resume: () => p.resume()
  }
}
