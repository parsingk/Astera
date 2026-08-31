// 트랜스크립트를 **뒤만** 읽는다.
//
// 왜 parseTranscriptPreview 를 쓰지 않는가: 그 함수는 늘 파일 처음부터 스트림을 연다. 목록에서
// 항목을 한 번 열 때 쓰는 함수라 그래도 됐지만, Work Unit 감지는 세션이 도는 동안 반복해서 돈다.
//
// **실측(2026-08-29).** 이 컴퓨터의 기록 파일 중 가장 큰 것이 55MB · 21,738 줄이고, 전체를 읽어
// 줄마다 JSON.parse 하는 데 246ms 였다. 디바운스 상한이 1000ms 이므로 세션이 계속 쓰는 동안
// 최소 1초마다 발화하고, 그러면 코어 하나의 25% 를 그 파일 하나에 쓰게 된다. 세션을 여럿 띄우는
// 것이 이 앱의 기본 사용법이므로 그만큼 곱해진다.
//
// 트랜스크립트는 추가 전용이라 이미 읽은 부분은 바뀌지 않는다. 그래서 오프셋을 들고 뒤만 읽는다.
import { promises as fs } from 'node:fs'
import type { TranscriptCursor } from '../../core/workUnit/types'

export interface TailResult {
  /** 이번에 새로 읽은 **온전한** 줄들. 개행으로 끝나지 않은 마지막 조각은 들어 있지 않다 */
  lines: string[]
  /** 다음에 여기서부터 읽는다 */
  offset: number
  /** 이번에 본 파일 크기 */
  sizeAtRead: number
  /** 처음부터 다시 읽었는가 (커서가 없었거나 무효였다) */
  restarted: boolean
}

export async function readNewLines(
  filePath: string,
  cursor: Pick<TranscriptCursor, 'offset' | 'sizeAtRead'> | null
): Promise<TailResult> {
  let size: number
  try {
    size = (await fs.stat(filePath)).size
  } catch {
    // 아직 없다. 세션이 막 시작해 파일이 만들어지기 전일 수 있다
    return { lines: [], offset: 0, sizeAtRead: 0, restarted: true }
  }

  // **파일이 저장한 크기보다 작아졌으면 처음부터 다시 읽는다.** 잘렸거나 다른 파일이고, 그때
  // 옛 오프셋은 전혀 다른 내용의 한가운데를 가리킨다.
  const canResume = cursor !== null && cursor.offset <= size && cursor.sizeAtRead <= size
  const start = canResume ? cursor.offset : 0

  if (start === size) return { lines: [], offset: start, sizeAtRead: size, restarted: !canResume }

  const handle = await fs.open(filePath, 'r')
  let buf: Buffer
  try {
    buf = Buffer.alloc(size - start)
    const { bytesRead } = await handle.read(buf, 0, buf.length, start)
    // 할당한 버퍼보다 짧게 읽혔으면 남은 부분은 영()이고, 이를 파일 내용으로 삼으면 줄이 사라진다.
    buf = buf.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }

  // **마지막 개행까지만 취한다.** 그 뒤는 아직 쓰이는 중인 반쪽 줄일 수 있고, 반쪽을 JSON.parse
  // 에 넘기면 그 줄은 영영 사라진다 — 다음 읽기가 그 뒤부터 시작하기 때문이다.
  const lastNewline = buf.lastIndexOf(0x0a)
  if (lastNewline === -1) return { lines: [], offset: start, sizeAtRead: size, restarted: !canResume }

  const complete = buf.subarray(0, lastNewline + 1).toString('utf8')
  const lines = complete.split('\n').filter((l) => l !== '')

  return {
    lines,
    offset: start + lastNewline + 1,
    sizeAtRead: size,
    restarted: !canResume
  }
}
