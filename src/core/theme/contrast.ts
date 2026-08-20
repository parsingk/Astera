import { parseColor } from './color'

/** WCAG 2.1 상대휘도. sRGB 채널을 선형화해 가중 합한다. */
export function relativeLuminance(color: string): number {
  const c = parseColor(color)
  if (!c) return 0
  const lin = (v: number): number => {
    const x = v / 255
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
}

/** 두 색의 대비비. 알파가 있는 색은 호출자가 flatten() 으로 합성해 넘긴다. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}
