import { describe, it, expect } from 'vitest'
import { shouldForceWaylandOzone, WSLG_MARKER } from './ozone'

/** 존재하는 경로 집합을 받아 exists 심을 만든다 */
const existsIn =
  (...paths: string[]) =>
  (p: string): boolean =>
    paths.includes(p)

const inWslg = existsIn(WSLG_MARKER)

describe('shouldForceWaylandOzone — Wayland 강제 조건 (실측 근거)', () => {
  it('WSLg + WAYLAND_DISPLAY면 강제한다', () => {
    expect(shouldForceWaylandOzone('linux', 'wayland-0', inWslg)).toBe(true)
  })

  it('WSLg여도 WAYLAND_DISPLAY가 없으면 강제하지 않는다 — 폴백이 없어 앱이 뜨지 못할 수 있다', () => {
    expect(shouldForceWaylandOzone('linux', undefined, inWslg)).toBe(false)
    expect(shouldForceWaylandOzone('linux', '', inWslg)).toBe(false)
  })

  it('WSLg가 아닌 리눅스 Wayland 세션은 제외한다 — 실제 데스크톱에서 검증하지 못했다', () => {
    expect(shouldForceWaylandOzone('linux', 'wayland-0', existsIn())).toBe(false)
  })

  it('리눅스가 아니면 조건을 보지도 않는다', () => {
    expect(shouldForceWaylandOzone('win32', 'wayland-0', inWslg)).toBe(false)
    expect(shouldForceWaylandOzone('darwin', 'wayland-0', inWslg)).toBe(false)
  })

  it('WSLg 판별은 /mnt/wslg 존재로 한다 — GUI 런처에서 뜨면 WSL_DISTRO_NAME 같은 환경변수가 없을 수 있다', () => {
    expect(WSLG_MARKER).toBe('/mnt/wslg')
    // 다른 WSL 경로가 있어도 마커가 없으면 WSLg로 보지 않는다
    expect(shouldForceWaylandOzone('linux', 'wayland-0', existsIn('/mnt/c'))).toBe(false)
  })
})
