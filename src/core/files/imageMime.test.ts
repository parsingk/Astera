import { describe, it, expect } from 'vitest'
import { imageMime } from './imageMime'

describe('imageMime', () => {
  it('허용 목록의 일곱 확장자를 올바른 MIME으로 매핑한다', () => {
    expect(imageMime('png')).toBe('image/png')
    expect(imageMime('jpg')).toBe('image/jpeg')
    expect(imageMime('jpeg')).toBe('image/jpeg')
    expect(imageMime('gif')).toBe('image/gif')
    expect(imageMime('webp')).toBe('image/webp')
    expect(imageMime('avif')).toBe('image/avif')
    expect(imageMime('svg')).toBe('image/svg+xml')
  })

  it('대소문자를 무시한다', () => {
    expect(imageMime('PNG')).toBe('image/png')
    expect(imageMime('SvG')).toBe('image/svg+xml')
    expect(imageMime('JPEG')).toBe('image/jpeg')
  })

  it('허용 목록 밖의 확장자는 거부한다', () => {
    expect(imageMime('exe')).toBeUndefined()
    expect(imageMime('bmp')).toBeUndefined()
    expect(imageMime('')).toBeUndefined()
  })

  it('Object.prototype에서 상속되는 이름은 거부한다 — plain object 조회가 원형으로 새는 것을 막는다', () => {
    // 소문자화 자체가 toString·valueOf 등은 막지만(대문자로 쓰지 않는 한 원래도 도달하지 않는다),
    // constructor·__proto__는 소문자 그대로도 Object.prototype에 있는 이름이라 별도 방어가 필요하다.
    expect(imageMime('constructor')).toBeUndefined()
    expect(imageMime('__proto__')).toBeUndefined()
    expect(imageMime('CONSTRUCTOR')).toBeUndefined()
  })
})
