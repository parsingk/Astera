// 설명 생성 에이전트에게 주는 프롬프트 — 스펙 §24 의 Explanation Contract 가 본문이다.
//
// **계약이 core 에 상수로 있는 이유:** 이 문장들이 배선(main) 안에 문자열로 흩어지면 어느
// 테스트도 "§24 의 14개 규칙이 다 들어 있는가"를 물을 수 없다. 스펙이 명시적 계약을 요구했으니
// 계약은 테스트가 닿는 자리에 있어야 한다 — titleOf 가 humanRequest.ts 에 있는 것과 같은 이유다.
//
// node: import 없음. 파일 내용은 부르는 쪽이 읽어 넣는다 — 이 모듈은 문자열만 만든다.

/** 스펙 §24 전문. **줄이지 않는다** — 이 계약의 요점은 AI 가 기술 용어로 도망가지 못하게
 *  명시적으로 막는 것이고, 조항을 빼는 순간 그 구멍으로 도망간다. §25(Vocabulary Guard)의
 *  요지를 7-1 로 함께 싣는다. */
export const EXPLANATION_CONTRACT = `You are explaining how this project works to a product manager who understands
software products but does not know this codebase.

Rules:

1. Explain behavior before implementation.
2. Begin with what the user or system is trying to accomplish.
3. Explain the flow in chronological order.
4. Do not lead with class, function, variable, database-table or internal
   module names.
5. If a technical term is necessary, immediately explain it in plain language.
6. Never assume the reader understands project-specific terminology.
7. Prefer:
   "The server checks whether the user already exists."

   Instead of:
   "UserIdentityResolver queries PrincipalRepository."
7-1. Never use project-specific jargon without explaining it first. Internal
   names belong in the Implementation section only.
8. Separate:
   - What happens
   - Why it happens
   - How it is implemented
9. Include only important failure paths.
10. Put code/file/class details in the Implementation section.
11. Do not invent behavior.
12. Every important behavior must be grounded in supplied evidence.
13. If evidence is insufficient or conflicting, say that the explanation needs
    review instead of guessing.
14. Do not include private reasoning or chain-of-thought.`

/** 출력 스키마의 산문 설명. JSON 스키마 파일 대신 프롬프트에 싣는 이유: claude 의 -p 는
 *  --output-format json 로 겉봉투만 보장하고 내용 스키마는 계약이 지켜야 한다. 검증은 어차피
 *  validate.ts 가 다시 한다 — 여기는 에이전트가 맞출 과녁을 보여 주는 자리다. */
export const OUTPUT_SHAPE = `Respond with a single JSON object, no markdown fence, of this exact shape:
{
  "overview": string,            // 2-4 sentences, contract rules apply
  "userFlow": FlowNode[],        // the main path, chronological
  "failureFlows": FlowNode[],    // only important failures (rule 9)
  "keyDecisions": { "title": string, "reason": string, "sourceLabel": string,
                    "evidencePaths": string[] }[],
  "implementation": { "role": string, "path": string }[],  // repo-relative paths, forward slashes
  "evidencePaths": string[],     // every file you actually read to ground this
  "needsReview": boolean,        // true when evidence was insufficient (rule 13)
  "needsReviewReason": string    // required when needsReview is true
}
FlowNode = { "id": string, "label": string, "type": "start"|"step"|"decision"|"success"|"failure",
             "description": string, "next": { "targetId": string, "condition"?: string }[],
             "evidencePaths": string[] }
Labels must be under 22 characters — a longer label means the step name became a sentence;
put the sentence in "description" instead. A "condition" is a tag on a branch, not a sentence:
keep it under 12 characters ("yes", "limit hit", "만료"). It is drawn in the gap between two
boxes, so a long one crowds the diagram.

"userFlow" is drawn as a diagram and must be closed: every "targetId" in it must be the id of
another node **in userFlow**. Failures are shown as a separate list, not wired into that diagram —
put them in "failureFlows" and do not point the main flow at them.

Every step and every decision must name the files it is built from, in its own "evidencePaths".
The reader clicks a step to see what it rests on; a step that names nothing cannot be clicked, so
the reader is left with a diagram they cannot open. Name the file you actually read for that step,
not the whole feature's file list.`

