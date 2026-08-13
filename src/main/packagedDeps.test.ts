import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// 패키징 회귀 가드. externalizeDepsPlugin 때문에 main 번들은 의존성을 require로 남기고,
// electron-builder는 "우리 package.json에 선언된 production 트리"만 asar에 복사한다.
// 그래서 누군가의 peerDependency는 dev(hoisted된 npm 설치본)에서는 잘 돌지만
// 패키징 앱에서 Cannot find module로 죽는다 — 0.3.9의 undici(@slack/socket-mode peer)가 그 사례.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function readPkg(dir: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

/** 선언된 production 의존성 트리를 훑어, 우리가 선언하지 않은 non-optional peer를 모은다. */
function unmetPeers(declared: string[]): string[] {
  const seen = new Set<string>()
  const unmet: string[] = []

  const walk = (name: string): void => {
    if (seen.has(name)) return
    seen.add(name)
    // npm hoisting 전제로 루트 node_modules만 본다. 중첩 설치본은 건너뛴다(가드 목적상 충분).
    const pkg = readPkg(path.join(repoRoot, 'node_modules', name))
    if (!pkg) return

    const peers = (pkg.peerDependencies ?? {}) as Record<string, string>
    const meta = (pkg.peerDependenciesMeta ?? {}) as Record<string, { optional?: boolean }>
    for (const [peer, range] of Object.entries(peers)) {
      if (meta[peer]?.optional) continue
      if (!declared.includes(peer)) unmet.push(`${name} -> ${peer}@${range}`)
    }

    for (const dep of Object.keys((pkg.dependencies ?? {}) as Record<string, string>)) walk(dep)
  }

  declared.forEach(walk)
  return unmet
}

describe('패키징 의존성', () => {
  it('production 트리의 필수 peer는 모두 package.json dependencies에 선언되어 있다', () => {
    const root = readPkg(repoRoot)
    const declared = Object.keys((root?.dependencies ?? {}) as Record<string, string>)
    expect(declared.length).toBeGreaterThan(0)

    // 실패하면 그 peer를 dependencies에 추가해야 한다 — 안 하면 패키징 앱이 실행 즉시 죽는다.
    expect(unmetPeers(declared)).toEqual([])
  })
})
