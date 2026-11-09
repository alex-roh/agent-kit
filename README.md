# agent-kit

코딩 에이전트(Claude Code, Codex, Antigravity)가 모든 레포에서 따르는 공통 규칙과 작은 hook이다. 돌아가는 서버 없이, 이 레포의 파일을 받아 쓴다. 공개 레포이므로 비밀값과 개인 정보를 두지 않는다.

| 파일 | 내용 |
| --- | --- |
| `RULES.md` | 공통 규칙. 여기만 고치면 다음 세션부터 적용된다 |
| `hook.mjs` | 세션 시작 때 규칙과 그 레포 `TODO.md`의 지금 칸을 넣고, 문맥이 커지면 새 세션을 권할 때를 알리고, GitHub 실행을 앞에서 지켜보는 명령과 5초 이상의 `sleep`을 막고, kit으로 그리는 화면 파일을 처음 고칠 때 ui-kit 지침 0절을 한 번 알린다(막지 않음, 워치·데스크·위젯·시안 폴더는 건너뜀) |
| `log.mjs` | 레포들이 모인 폴더에서 각 레포 `LOG.md`(작업 기록, `RULES.md` "기록")를 날짜순으로 모아 보여 준다. `node agent-kit/log.mjs [낱말…] [--repo 이름] [--days N]` |
| `codex-usage.mjs` | Codex 5시간·주간 사용률을 한 줄로 읽는다(`codex app-server` JSON-RPC). Codex에 맡기기 전에 보인다. `node agent-kit/codex-usage.mjs [--raw]` |
| `settings.json` | 레포 `.claude/settings.json`에 넣을 내용 |
| `codex-hooks.json` | PC마다 `~/.codex/hooks.json`에 둘 내용. Codex의 `/hooks`에서 한 번 승인한다. 윈도우 Codex는 PowerShell을 쓰므로 어느 셸에서나 뜻이 같은 `node -e` 한 줄로 둔다 |

## 새 레포에 넣기

1. `AGENTS.md` 맨 위에 아래 한 줄을 넣는다.

   ```
   공통 규칙: 문맥에 `[공통 규칙]`이 없으면 https://raw.githubusercontent.com/alex-roh/agent-kit/main/RULES.md 를 읽고 따른다. 아래는 이 레포의 지침이다.
   ```

2. `CLAUDE.md`와 `GEMINI.md`에는 `@AGENTS.md`만 둔다.
3. `settings.json`의 내용을 레포 `.claude/settings.json`에 넣는다. 이미 다른 설정이 있으면 합친다.

## 새 PC

Git, Node, GitHub CLI와 쓰는 에이전트를 설치해 로그인하고 레포를 받으면 된다. hook과 규칙은 세션을 시작할 때 저절로 받는다. Codex를 쓰면 `codex-hooks.json`을 `~/.codex/hooks.json`에 두고 한 번 승인한다.

## 고칠 때

`node --test`를 돌린 뒤 main에 올린다. 받은 `hook.mjs`가 `node --check`를 통과하지 못하면 쓰던 것을 유지한다. `RULES.md`와 `hook.mjs`는 다음 세션부터 저절로 적용되지만, `settings.json`은 각 레포에 복사돼 있어 바꾸면 레포마다 맞춰야 한다.
