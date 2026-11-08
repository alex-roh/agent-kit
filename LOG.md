# 작업 기록

최신이 위. 쓰는 법은 `RULES.md` "기록", 모아 보기는 `node agent-kit/log.mjs`.

## 2026-11-07 · 레포별 작업 기록(LOG.md)과 모아 보기 추가
- 바꾼 것: `RULES.md`에 "기록" 절, 모든 레포의 LOG.md를 날짜순으로 합치고 낱말·레포·기간으로 거르는 `log.mjs`와 그 테스트. 교훈과 바꾼 것을 한 곳에서 볼 데가 없어서(사용자 요청)
- 알게 된 것: 훅은 모든 레포 settings.json에 같은 사본이 있고 동작은 `hook.mjs` 하나가 한다. Codex 쪽은 SessionStart만 있어 sleep·watch·화면 지침 막기가 없다
- 반영: RULES.md
