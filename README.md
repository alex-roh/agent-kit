# agent-kit

코딩 에이전트(Claude Code, Codex, Antigravity)가 모든 레포에서 따르는 공통 규칙과 작은 hook이다. 돌아가는 서버 없이, 이 레포의 파일을 받아 쓴다. 공개 레포이므로 비밀값과 개인 정보를 두지 않는다.

| 파일 | 내용 |
| --- | --- |
| `RULES.md` | 공통 규칙. 여기만 고치면 다음 세션부터 적용된다 |
| `hook.mjs` | 세션 시작 때 규칙을 넣고, 문맥이 커지면 새 세션을 권할 때를 알리고, GitHub 실행을 앞에서 지켜보는 명령을 막는다 |
| `settings.json` | 레포 `.claude/settings.json`에 넣을 내용 |
| `codex-hooks.json` | 레포 `.codex/hooks.json`에 넣을 내용 |

## 새 레포에 넣기

1. `AGENTS.md` 맨 위에 아래 한 줄을 넣는다.

   ```
   공통 규칙: 문맥에 `[공통 규칙]`이 없으면 https://raw.githubusercontent.com/alex-roh/agent-kit/main/RULES.md 를 읽고 따른다. 아래는 이 레포의 지침이다.
   ```

2. `CLAUDE.md`와 `GEMINI.md`에는 `@AGENTS.md`만 둔다.
3. `settings.json`과 `codex-hooks.json`의 내용을 넣는다. 이미 다른 설정이 있으면 합친다.

## 새 PC

Git, Node, GitHub CLI와 쓰는 에이전트를 설치해 로그인하고 레포를 받으면 된다. hook과 규칙은 세션을 시작할 때 저절로 받는다.

## 고칠 때

`node --test`를 돌린 뒤 main에 올린다. 받은 `hook.mjs`가 `node --check`를 통과하지 못하면 쓰던 것을 유지한다.
