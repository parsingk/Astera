/** 색 문자열의 채널. a 는 0~1. */
export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

/** `#rgb`, `#rrggbb`, `rgb(...)`, `rgba(...)` 만 읽는다 — 테마 값에 실제로 쓰는 형식이 이 넷이다.
 *  이름 색(`tomato`)이나 `hsl()` 은 지원하지 않고 null 을 준다: 지원하지 않는 형식이 테마 테이블에
 *  들어오면 대비 관문 테스트가 그것을 잡아야 하고, 여기서 조용히 추측하면 못 잡는다. */
export function parseColor(v: string): Rgba | null {
  const s = v.trim()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s)
  if (hex) {
    const h = hex[1]
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
      a: 1
    }
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(s)
  if (!fn) return null
  const parts = fn[1].split(',').map((p) => p.trim())
  if (parts.length < 3 || parts.length > 4) return null
  const [r, g, b] = parts.slice(0, 3).map(Number)
  const a = parts.length === 4 ? Number(parts[3]) : 1
  if ([r, g, b, a].some((n) => !Number.isFinite(n))) return null
  return { r, g, b, a }
}

const hex2 = (n: number): string => Math.round(n).toString(16).padStart(2, '0')

export function withAlpha(color: string, a: number): string {
  const c = parseColor(color)
  if (!c) return color
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${a})`
}

/** 알파가 있는 색을 불투명 배경 위에 얹은 실효색. 대비 계산은 실제로 보이는 색으로 해야 하고,
 *  Umbra 의 경계색이 `rgba(255,255,255,.07)` 이라 이것이 필요하다. */
export function flatten(color: string, over: string): string {
  const c = parseColor(color)
  const bg = parseColor(over)
  if (!c || !bg) return color
  if (c.a >= 1) return color
  const mix = (x: number, y: number): number => y + (x - y) * c.a
  return `#${hex2(mix(c.r, bg.r))}${hex2(mix(c.g, bg.g))}${hex2(mix(c.b, bg.b))}`
}
