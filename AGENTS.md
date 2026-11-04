공통 규칙: 문맥에 `[공통 규칙]`이 없으면 https://raw.githubusercontent.com/alex-roh/agent-kit/main/RULES.md 를 읽고 따른다. 아래는 이 레포의 지침이다.

이 레포는 모든 레포가 받아 쓰는 공통 규칙과 hook의 원본이다. 파일별 역할은 `README.md`에 있다.

- 공개 레포다. 비밀값, 토큰, 개인 경로, 레포별 내용을 두지 않는다.
- 고친 내용은 main에 올린 다음 세션부터 모든 레포에 적용된다. 깨지면 모든 세션에 번지므로 `node --test`를 돌린 뒤 올린다.
- `.claude/settings.json`은 맨 위 `settings.json`의 사본이다. 하나를 바꾸면 다른 하나도 맞춘다.
