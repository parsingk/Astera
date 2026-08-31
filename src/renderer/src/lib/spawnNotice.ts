// 세션을 하나 띄운 뒤 사용자에게 알려야 할 것이 있는지 가른다. App.tsx 의 spawn() 이 쓰는 유일한
// 자리이지만 그 파일은 테스트가 닿지 않으므로, 판정만 여기로 뺀다 — main 쪽에서 spawnSession 의
// 판정을 ipc.ts 의 historyResumePlan 으로 뺀 것과 같은 이유다.
//
// **두 알림 모두 "요청한 것과 다른 일이 일어났다" 를 말한다.** 재개를 요청했는데 화면에 뜬 것이
// 그 대화가 아니면, 그 사실을 말해 주지 않는 한 사용자는 대화가 사라졌다고 읽는다.

/** 알릴 것. 값은 i18n 키의 `session.spawn.` 뒤쪽과 같다 — 부르는 쪽이 그대로 이어 붙인다. */
export type SpawnNotice = 'resumeLiveIgnored' | 'smartResume' | null

export function spawnNotice(a: {
  /** 모달이 재개하려던 대화의 id. 새 세션이면 undefined. */
  requestedResumeSessionId: string | undefined
  /** 돌아온 세션이 실제로 재개한 대화의 id(`SessionInfo.resumeSessionId`). **백지 재개면
   *  undefined 다** — spawnSession(main/ipc.ts)이 백지로 갈 때 이 값을 지우고 넘기기 때문이고,
   *  그것이 이 판정이 읽는 신호다. 그쪽 분기가 바뀌면 이 함수도 함께 바뀌어야 한다. */
  returnedResumeSessionId: string | undefined
  /** 돌아온 세션이 이미 열려 있던 탭인가. main 의 롤링 가드가 걸리면 새로 띄우지 않고 살아 있는
   *  탭을 그대로 돌려준다. */
  returnedTabAlreadyOpen: boolean
}): SpawnNotice {
  if (!a.requestedResumeSessionId) return null // 재개가 아니었다 — 어긋날 것이 없다
  // 가드가 먼저다. 돌려받은 것이 이번에 띄운 세션이 아니라 원래 있던 탭이면 이번 재개는 일어나지도
  // 않았으므로, 아래 백지 판정을 그대로 적용하면 일어나지 않은 일을 알리게 된다.
  if (a.returnedTabAlreadyOpen) return 'resumeLiveIgnored'
  return a.returnedResumeSessionId === undefined ? 'smartResume' : null
}
