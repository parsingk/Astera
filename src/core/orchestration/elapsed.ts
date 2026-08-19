/** 경과 시간의 표시 형태. 렌더러가 아니라 여기 있는 이유는 렌더러에 테스트가 없기 때문이다 —
 *  경계(분·시간)의 규칙은 테스트가 닿는 자리에 있어야 한다.
 *
 *  now 를 인자로 받는다: 모듈이 시계를 읽으면 테스트가 시각에 의존하게 된다. 렌더러가 1초마다
 *  다시 그리며 자기 시계를 넘긴다. */
export function formatElapsed(fromIso: string, nowMs: number): string {
  const started = Date.parse(fromIso)
  // startedAt 은 다른 프로세스의 시계에서 온 값이라 앞설 수 있다. 음수를 그리는 대신 0 으로 본다
  const ms = Number.isNaN(started) ? 0 : Math.max(0, nowMs - started)
  const total = Math.floor(ms / 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
