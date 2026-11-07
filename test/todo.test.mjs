import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isOldTodo, parseTodo, repoTodoText, todoText } from "../hook.mjs";

const hook = fileURLToPath(new URL("../hook.mjs", import.meta.url));
const today = new Date(2026, 10, 7);

function withFolder(fn) {
  const dir = mkdtempSync(join(tmpdir(), "agent-kit-todo-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeRepo(dir, name, todo) {
  const repo = join(dir, name);
  mkdirSync(join(repo, ".git"), { recursive: true });
  if (todo !== undefined) writeFileSync(join(repo, "TODO.md"), todo);
  return repo;
}

test("parseTodo splits the two sections and takes items before a heading as 지금", () => {
  assert.deepEqual(parseTodo("﻿- 첫째\r\n# 나중\r\n- 둘째\r\n  - 하위\r\n설명\r\n## 지금\n- 셋째\n"), {
    now: ["첫째", "셋째"],
    later: ["둘째"],
  });
});

test("isOldTodo marks only what is past 30 days, across a new year", () => {
  assert.equal(isOldTodo("가 (10-08)", today), false);
  assert.equal(isOldTodo("가 (10-07)", today), true);
  assert.equal(isOldTodo("날짜 없음", today), false);
  assert.equal(isOldTodo("가 (12-20)", new Date(2027, 0, 5)), false);
  assert.equal(isOldTodo("가 (11-20)", new Date(2027, 0, 5)), true);
});

test("repoTodoText reads out 지금 only, up to five, and counts the rest", () => {
  const six = [1, 2, 3, 4, 5, 6].map((n) => `- 일${n} (11-01)`).join("\n");
  const text = repoTodoText(`# 지금\n${six}\n# 나중\n- 비밀스런 장기 일\n- 또 하나\n`, today);
  assert.match(text, /^\[할 일\]/);
  assert.match(text, /일5/);
  assert.doesNotMatch(text, /일6/);
  assert.doesNotMatch(text, /장기 일/);
  assert.match(text, /\(지금 칸 외 1개, 나중 2개\)$/);
  assert.doesNotMatch(text, /- 일1.*\[오래됨\]/);
  assert.match(repoTodoText("# 지금\n- 묵은 일 (09-01)\n", today), /- 묵은 일 \(09-01\) \[오래됨\]/);
  assert.equal(repoTodoText("# 지금\n\n# 나중\n", today), "");
  assert.equal(repoTodoText("", today), "");
});

test("todoText finds the repo from below it, and an empty repo stays silent", () => {
  withFolder((dir) => {
    const repo = makeRepo(dir, "life", "# 지금\n- 할 것\n");
    const below = join(repo, "site", "src");
    mkdirSync(below, { recursive: true });
    assert.match(todoText(repo, today), /- 할 것/);
    assert.match(todoText(below, today), /- 할 것/);
    assert.equal(todoText(makeRepo(dir, "empty"), today), "");
  });
});

test("todoText in a folder of repos counts per repo and skips folders that are not repos", () => {
  withFolder((dir) => {
    makeRepo(dir, "life", "# 지금\n- 하나\n- 둘\n# 나중\n- 셋\n");
    makeRepo(dir, "fonts");
    mkdirSync(join(dir, "notes"));
    writeFileSync(join(dir, "notes", "TODO.md"), "- 레포 아님\n");
    const text = todoText(dir, today);
    assert.match(text, /life 지금 2·나중 1/);
    assert.doesNotMatch(text, /fonts|notes|하나/);
  });
});

test("the list comes with the rules on a new session, not after a resume or a compaction", () => {
  withFolder((dir) => {
    const repo = makeRepo(dir, "life", "# 지금\n- 할 것\n");
    const start = (source, tool = "claude") =>
      spawnSync(process.execPath, [hook, tool], {
        input: JSON.stringify({ hook_event_name: "SessionStart", source, cwd: repo }),
        encoding: "utf8",
      }).stdout;
    assert.match(start("startup"), /- 할 것/);
    assert.match(start("clear"), /- 할 것/);
    assert.doesNotMatch(start("compact"), /- 할 것/);
    assert.equal(start("resume"), "");
    assert.match(JSON.parse(start("startup", "codex")).hookSpecificOutput.additionalContext, /- 할 것/);
  });
});

test("a TODO.md that cannot be read does not lose the session", () => {
  withFolder((dir) => {
    const repo = makeRepo(dir, "life");
    mkdirSync(join(repo, "TODO.md"));
    const result = spawnSync(process.execPath, [hook, "claude"], {
      input: JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: repo }),
      encoding: "utf8",
    });
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /\[할 일\]/);
  });
});
