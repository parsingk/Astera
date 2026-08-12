// 파일별 EditorState와 스크롤 위치의 캐시. 되돌리기·커서·스크롤이 탭 전환을 살아남게 하는 것이 목적이다.
//
// FileEditor 내부의 useRef에 있던 것을 밖으로 뺐다. 인스턴스가 하나인 지금은 차이가 없지만, 에디터
// 모드가 분할되면 페인마다 FileEditor가 생긴다. 캐시가 컴포넌트 안에 있으면 인스턴스마다 갈라지고,
// 페인을 닫을 때 그 페인이 들고 있던 되돌리기 이력이 함께 사라진다. 소유자를 페인보다 위로 올려 두면
// 파일이 페인을 옮겨 다녀도 상태가 따라간다.
//
// 그래서 drop은 파일 탭이 완전히 닫힐 때만 부른다. 페인이 사라지는 것은 파일이 닫히는 것과 다르다.
import type { EditorState } from '@codemirror/state'

export interface CachedEditorState {
  state: EditorState
  scrollTop: number
}

export class EditorStateCache {
  private entries = new Map<string, CachedEditorState>()

  get(path: string): CachedEditorState | undefined {
    return this.entries.get(path)
  }

  save(path: string, state: EditorState, scrollTop: number): void {
    this.entries.set(path, { state, scrollTop })
  }

  drop(path: string): void {
    this.entries.delete(path)
  }
}
