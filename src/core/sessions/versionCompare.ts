// Version strings read and compared, with no `node:` import, so a reader with no file access (the Runtime detail,
// controlPlane/detail.ts) compares the way the CLI version probe does (cliVersion.ts).

/** `2.1.311 (Claude Code)` → `2.1.311`; `codex-cli 0.160.0` → `0.160.0`; a pre-release keeps its numbers. */
export function parseCliVersion(text: string): string | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null
}

/** Whether `found` is `min` or later, part by part as numbers. */
export function atLeast(found: string, min: string): boolean {
  const a = found.split('.').map(Number)
  const b = min.split('.').map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return true
}
