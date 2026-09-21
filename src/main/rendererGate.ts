/** 렌더러가 듣기 시작하기 전에 도착한 재생 데이터를 붙잡아 두는 자리.
 *
 *  `registerIpc` 의 `send` 는 `win.webContents.send` 한 줄이고 버퍼가 없다. 그 사실이 평소에는
 *  드러나지 않는 것은, 렌더러가 놓친 것을 대개 되물을 수 있기 때문이다 — 탭도 세션도 터미널도
 *  App.tsx 가 `sessions.list()`/`terminal.list()` 로 다시 조회해 복원한다.
 *
 *  Host 의 ring buffer 만은 되물을 수 없다. `reattach.ts` 가 세션을 입양하고 `sendAttach` 를
 *  보내면 Host 는 보관하던 스크롤백을 평범한 출력으로 단 한 번 돌려주고, 그것을 들을 리스너가
 *  아직 없으면 그대로 사라진다. 그리고 그 시점은 하필 앱이 켜진 직후다 — 업데이트 뒤 재시작에서
 *  측정된 값으로, Host 연결부터 재부착 완료까지가 부팅 후 130ms 였다. 렌더러가 번들을 실행해
 *  `sessionBus.init()` 이 채널에 리스너를 걸기까지는 그보다 한참 걸린다.
 *
 *  그래서 사람이 보는 것은 탭은 제자리에 있는데 속은 빈 터미널 — 검은 화면 — 이었다. 창을
 *  끌어 크기를 바꾸면 pty 에 resize 가 가고 TUI 가 화면을 다시 그려서, 잃은 스크롤백이 아니라
 *  지금 화면이 새로 나타난다. 고쳐야 할 것은 그 한 구간의 유실이다.
 *
 *  붙잡는 대상을 `REPLAYED_CHANNELS` 로 좁히는 것은 그 때문이다. 이 게이트는 부팅의 한 구간을
 *  메우는 물건이지 이벤트 큐가 아니고, 나머지 이벤트까지 보류했다가 한꺼번에 푸는 것은 조회로
 *  이미 복원되는 상태를 뒤늦게 덮어쓸 위험만 더한다.
 *
 *  **`terminal:data` 가 여기 없는 것은 그쪽은 애초에 잃지 않기 때문이다.** 프로젝트 터미널의
 *  재생도 같은 순간에 같은 방식으로 지나가지만, 메인이 그것을 자기 손에 남긴다 —
 *  `TerminalManager` 는 pty 의 출력을 그때그때 `live.buffer` 에 쌓고(terminalManager.ts), 렌더러는
 *  패널을 열 때 `terminal.list(projectPath)` 로 그 버퍼를 통째로 받아 `TerminalBody` 의
 *  `initialBuffer` 로 재생한다. 이벤트를 놓쳐도 되물을 곳이 있으니 붙잡을 이유가 없다.
 *
 *  세션에는 그 손이 없다. `core/sessions/manager.ts` 가 하는 것은 backpressure 이지 보관이
 *  아니어서, 메인 어디에도 세션의 스크롤백이 남지 않는다 — App.tsx 가 세션을 다시 탭으로 붙이며
 *  "scrollback is lost, by design" 이라고 적어 둔 것이 그 뜻이다. 그래서 놓친 것을 되물을 곳이
 *  세션에만 없고, 이 게이트가 필요한 곳도 세션뿐이다. */
const REPLAYED_CHANNELS: ReadonlySet<string> = new Set(['session:data'])

/** 열어 줄 렌더러가 끝내 오지 않을 때를 위한 상한. UTF-16 code unit 으로 세는 것은 Host 의
 *  `SCROLLBACK_CHARS` 와 같은 이유다(host/registry.ts) — 한글 한 자는 1 unit, 2 byte 라 byte 로
 *  세면 한국어 세션의 몫만 반으로 준다.
 *
 *  값은 그 세션당 256,000 자의 열여섯 배다. 한 번의 재부착으로 돌아오는 세션이 여럿일 수 있어
 *  한 세션분으로는 모자라고, 그렇다고 무제한이면 렌더러가 죽은 채 돌아가는 앱에서 이 배열이
 *  남은 수명 내내 자란다. 정상 경로에서는 몇 초 만에 열리므로 여기에 닿을 일 자체가 없다. */
export const HELD_CHARS_CAP = 256_000 * 16

/** 붙잡은 한 조각의 무게. 이 게이트가 붙잡는 두 채널의 payload 는 모두 `data` 에 문자열을 싣고
 *  있고(`{ sessionId, data }` / `{ terminalId, data }`), 무게는 그 문자열이 전부다. 모양이 다른
 *  것이 섞여 들어오면 0 으로 세어 상한을 건드리지 않게 둔다 — 상한은 재생 데이터의 양을 재려는
 *  것이지 조각 수를 세려는 것이 아니다. */
function charsOf(payload: unknown): number {
  const data = (payload as { data?: unknown } | null)?.data
  return typeof data === 'string' ? data.length : 0
}

export interface RendererGate {
  /** `send` 가 이 자리를 지난다. 열리기 전의 재생 데이터만 붙잡고, 나머지는 그대로 통과한다. */
  send: (channel: string, payload: unknown) => void
  /** 렌더러가 리스너를 걸었다고 알려 온 순간. 붙잡아 둔 것을 온 순서대로 흘리고 길을 연다.
   *
   *  풀어 준 양을 돌려주는 것은 로그를 위해서다. 이 경로는 업데이트 뒤 재시작처럼 Host 가 세션을
   *  쥔 채 앱만 다시 뜨는 때에만 밟히고, 평소 실행에서는 붙잡을 것 자체가 없다 — 그래서 다음에
   *  같은 일이 벌어졌을 때 게이트가 실제로 무언가를 건졌는지 사람이 확인할 근거가 필요하다. */
  open: () => { count: number; chars: number }
}

export function createRendererGate(
  deliver: (channel: string, payload: unknown) => void
): RendererGate {
  let opened = false
  const held: Array<[string, unknown]> = []
  let heldChars = 0
  return {
    send: (channel, payload) => {
      if (opened || !REPLAYED_CHANNELS.has(channel)) {
        deliver(channel, payload)
        return
      }
      held.push([channel, payload])
      heldChars += charsOf(payload)
      // 앞에서부터 버린다. 터미널이 이것으로 되살리는 것은 최근 화면이지 한참 전의 줄이 아니다
      // — sessionBus 의 BUFFER_CAP 이 같은 이유로 같은 선택을 한다.
      while (heldChars > HELD_CHARS_CAP && held.length > 1) {
        const [, dropped] = held.shift() as [string, unknown]
        heldChars -= charsOf(dropped)
      }
    },
    open: () => {
      opened = true
      const chars = heldChars
      heldChars = 0
      // splice 로 먼저 비우고 흘린다 — deliver 가 무엇을 하든 이 배열은 이미 게이트의 것이
      // 아니어야 한다. 두 번째 open 은 그래서 빈 배열을 만나 아무것도 두 번 보내지 않는다.
      const releasing = held.splice(0)
      for (const [channel, payload] of releasing) deliver(channel, payload)
      return { count: releasing.length, chars }
    }
  }
}
