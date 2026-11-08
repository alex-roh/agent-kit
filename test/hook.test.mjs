import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  commandOnly,
  contextBand,
  contextNote,
  contextTokens,
  isForegroundSleep,
  isForegroundWatch,
  isScreenFile,
  readGuideline,
  rulesText,
} from "../hook.mjs";

const hook = fileURLToPath(new URL("../hook.mjs", import.meta.url));
const row = (usage, extra = {}) => JSON.stringify({ type: "assistant", message: { usage }, ...extra });
const run = (input, tool = "claude", env = {}) =>
  spawnSync(process.execPath, [hook, tool], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

test("context size comes from the last main-thread call, and a compaction resets it", () => {
  const main = row({ input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 });
  const sub = row({ input_tokens: 999 }, { isSidechain: true });
  assert.equal(contextTokens(`${main}\n${sub}\n`), 6);
  assert.equal(contextTokens(`${main}\n{"isCompactSummary":true}\n`), 0);
  assert.equal(contextTokens("not json\n"), 0);
});

test("the context note stays silent below 200K and speaks once per 50K band", () => {
  assert.equal(contextNote(199_999), "");
  assert.match(contextNote(210_000), /21만 토큰.*약 131턴/);
  assert.equal(contextBand(199_999), 0);
  assert.equal(contextBand(210_000), 200_000);
  assert.equal(contextBand(260_000), 250_000);
});

test("only a really running foreground watch is blocked", () => {
  assert.ok(isForegroundWatch({ command: "gh run watch 123" }));
  assert.ok(isForegroundWatch({ command: "cd x && gh pr checks 5 --watch" }));
  assert.ok(!isForegroundWatch({ command: "gh run watch 123", run_in_background: true }));
  assert.ok(!isForegroundWatch({ command: "gh pr checks 5" }));
  assert.ok(!isForegroundWatch({ command: "gh pr checks 5; ls --watch" }));
  assert.ok(!isForegroundWatch({ command: 'git commit -m "gh run watch를 막음"' }));
  assert.ok(!isForegroundWatch({ command: "cat > a.md <<'EOF'\ngh run watch 1\nEOF\nls" }));
  assert.ok(isForegroundWatch({ command: "cat > a.md <<'EOF'\ntext\nEOF\ngh run watch 1" }));
  assert.equal(commandOnly("ls"), "ls");
});

test("only a really running foreground sleep of 5 seconds or more is blocked", () => {
  for (const command of [
    "sleep 5",
    "sleep 2m",
    "sleep 20 && git add a.txt",
    "ls; sleep 30",
    "while true; do sleep 10; done",
    "Start-Sleep 30",
    "Start-Sleep -Seconds 30",
    "git status; start-sleep -s 60",
  ]) {
    assert.ok(isForegroundSleep({ command }), command);
  }
  for (const command of [
    "sleep 2",
    "sleep 0.5 && git add a.txt",
    "Start-Sleep -Milliseconds 5000",
    "python sleep.py 30",
    "git log --grep sleep 30",
    'git commit -m "sleep 30을 막음"',
    "cat > a.md <<'EOF'\nsleep 30\nEOF\nls",
  ]) {
    assert.ok(!isForegroundSleep({ command }), command);
  }
  assert.ok(!isForegroundSleep({ command: "sleep 30", run_in_background: true }));
  assert.ok(!isForegroundSleep({}));
});

test("a foreground sleep returns 2 and says what to do", () => {
  const r = run({ hook_event_name: "PreToolUse", tool_name: "PowerShell", tool_input: { command: "Start-Sleep 30" } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /run_in_background/);
});

test("rules come from the saved file; none saved says nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-kit-test-"));
  assert.equal(rulesText(join(dir, "none.md")), "");
  writeFileSync(join(dir, "RULES.md"), "# 규칙\n");
  assert.match(rulesText(join(dir, "RULES.md")), /^\[공통 규칙\].*\n\n# 규칙$/);
});

test("the script blocks with exit 2, and bad input never stops the agent", () => {
  const blocked = run({ hook_event_name: "PreToolUse", tool_input: { command: "gh run watch 1" } });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /run_in_background/);
  assert.equal(run({ hook_event_name: "PreToolUse", tool_input: { command: "ls" } }).status, 0);
  assert.equal(run("not json").status, 0);
  assert.equal(run({ hook_event_name: "UserPromptSubmit", transcript_path: "/none", session_id: "x" }).status, 0);
});

test("a new session gets the rules, a resumed one does not; Codex gets JSON", () => {
  const home = mkdtempSync(join(tmpdir(), "agent-kit-home-"));
  const env = { USERPROFILE: home, HOME: home };
  const start = { hook_event_name: "SessionStart", source: "startup" };
  assert.equal(run(start, "claude", env).stdout, "");
  const dir = join(home, ".agent-kit");
  spawnSync(process.execPath, ["-e", `require("fs").mkdirSync(${JSON.stringify(dir)})`]);
  writeFileSync(join(dir, "RULES.md"), "# 규칙\n");
  assert.match(run(start, "claude", env).stdout, /^\[공통 규칙\]/);
  assert.equal(run({ ...start, source: "resume" }, "claude", env).stdout, "");
  const codex = JSON.parse(run(start, "codex", env).stdout);
  assert.equal(codex.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(codex.hookSpecificOutput.additionalContext, /# 규칙/);
});

// Codex on Windows runs commands in PowerShell, where the first Bash version failed to parse (2026-11-04).
test("the Codex command means the same in Bash, PowerShell and cmd", () => {
  const url = new URL("../codex-hooks.json", import.meta.url);
  const { command } = JSON.parse(readFileSync(url, "utf8")).hooks.SessionStart[0].hooks[0];
  const code = command.match(/^node -e "(.*)"$/s)?.[1];
  assert.ok(code, "a single node -e call");
  assert.doesNotMatch(code, /["$`%\\]/);
});

test("screen files are told apart from vendored, test, doc and data files", () => {
  for (const p of [
    "site/src/render.js",
    "src/ui/pages-x.mjs",
    "cloudflare/admin-kit.mjs",
    "app/web/src/app/nav.ts",
    "a/b.tsx",
    "a/b.css",
    "src\\ui\\x.mjs",
  ])
    assert.ok(isScreenFile(p), p);
  for (const p of [
    "vendor/ui-kit/kit.js",
    "vendor/x.css",
    "tests/page.css",
    "site/test/render.test.js",
    "src/core/guidance-transfer.ts",
    "site/tools/build_data.py",
    "courses/notes/basics-quiz.js",
    "docs/ui-project.md",
    "site/src/data/a.json",
    "eval/guidance/a.txt",
  ])
    assert.ok(!isScreenFile(p), p);
});

const readRow = (file_path, name = "Read") =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input: { file_path } }] } });
const GL = "C:\\Github\\life\\vendor\\ui-kit\\GUIDELINES.md";

const bashRow = (command) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] } });

test("a shell read of the vendored guideline counts, a grep or another file does not", () => {
  assert.equal(readGuideline(`${bashRow('node tools/map.mjs 절 vendor/ui-kit/GUIDELINES.md "작업 순서"')}\n`), true);
  assert.equal(readGuideline(`${bashRow("cd /x && sed -n 1,40p vendor/ui-kit/GUIDELINES.md")}\n`), true);
  assert.equal(readGuideline(`${bashRow("Get-Content C:\\Github\\life\\vendor\\ui-kit\\GUIDELINES.md")}\n`), true);
  assert.equal(readGuideline(`${bashRow("grep -n 시안 vendor/ui-kit/GUIDELINES.md")}\n`), false);
  assert.equal(readGuideline(`${bashRow("cat vendor/worker-kit/GUIDELINES.md")}\n`), false);
  assert.equal(readGuideline(`${bashRow("cat ui-kit/GUIDELINES.md")}\n`), false);
});

test("only a Read of the vendored guideline after the last compaction counts", () => {
  assert.equal(readGuideline(`${readRow(GL)}\n`), true);
  assert.equal(readGuideline(`${readRow("C:/Github/life/vendor/ui-kit/GUIDELINES.md")}\n`), true);
  const user = JSON.stringify({ type: "user", message: { content: `see ${GL}` } });
  assert.equal(readGuideline(`${user}\n`), false);
  assert.equal(readGuideline(`${readRow("C:\\Github\\ui-kit\\GUIDELINES.md")}\n`), false);
  const grep = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Grep", input: { pattern: GL, path: GL } }] },
  });
  assert.equal(readGuideline(`${grep}\n`), false);
  const compact = '{"isCompactSummary":true}';
  assert.equal(readGuideline(`${readRow(GL)}\n${compact}\n`), false);
  assert.equal(readGuideline(`${readRow(GL)}\n${compact}\n${readRow(GL)}\n`), true);
  assert.equal(readGuideline(`{broken GUIDELINES.md\n${readRow(GL)}\n`), true);
});

function guidelineSetup({ withGuideline = true, readIt = false } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "agent-kit-repo-"));
  if (withGuideline) {
    mkdirSync(join(repo, "vendor", "ui-kit"), { recursive: true });
    writeFileSync(join(repo, "vendor", "ui-kit", "GUIDELINES.md"), "# g\n");
  }
  mkdirSync(join(repo, "src"), { recursive: true });
  const guide = join(repo, "vendor", "ui-kit", "GUIDELINES.md");
  const transcript = join(repo, "transcript.jsonl");
  writeFileSync(transcript, readIt ? `${readRow(guide)}\n` : `${row({ input_tokens: 1 })}\n`);
  const session_id = `s-${randomUUID()}`;
  const marker = join(tmpdir(), `agent-kit-guideline-${session_id.replace(/\W/g, "")}`);
  const call = (file_path, extra = {}) => ({
    hook_event_name: "PreToolUse",
    tool_name: "Edit",
    tool_input: { file_path, old_string: "a", new_string: "b" },
    session_id,
    transcript_path: transcript,
    cwd: repo,
    ...extra,
  });
  const cleanup = () => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(marker, { force: true });
  };
  return { repo, guide, transcript, session_id, call, cleanup };
}

test("a screen edit is stopped once until the guideline was read", () => {
  const t = guidelineSetup();
  try {
    const file = join(t.repo, "src", "ui.css");
    const first = run(t.call(file));
    assert.equal(first.status, 2);
    assert.ok(first.stderr.includes(t.guide), first.stderr);
    assert.equal(run(t.call(file)).status, 0);
  } finally {
    t.cleanup();
  }
});

test("a screen edit passes when the transcript shows the guideline was read", () => {
  const t = guidelineSetup({ readIt: true });
  try {
    assert.equal(run(t.call(join(t.repo, "src", "ui.css"))).status, 0);
  } finally {
    t.cleanup();
  }
});

test("a non-screen edit passes and leaves no marker behind", () => {
  const t = guidelineSetup();
  try {
    assert.equal(run(t.call(join(t.repo, "docs", "a.md"))).status, 0);
    assert.equal(run(t.call(join(t.repo, "src", "ui.css"))).status, 2);
  } finally {
    t.cleanup();
  }
});

test("editing the vendored kit itself or a repo without the guideline passes", () => {
  const t = guidelineSetup();
  const u = guidelineSetup({ withGuideline: false });
  try {
    assert.equal(run(t.call(join(t.repo, "vendor", "ui-kit", "kit.css"))).status, 0);
    assert.equal(run(u.call(join(u.repo, "src", "ui.css"))).status, 0);
  } finally {
    t.cleanup();
    u.cleanup();
  }
});

test("a missing transcript file or session id does not stop anything", () => {
  const t = guidelineSetup();
  try {
    const file = join(t.repo, "src", "ui.css");
    const noTranscript = run(t.call(file, { transcript_path: join(t.repo, "nope.jsonl") }));
    assert.equal(noTranscript.status, 0);
    assert.equal(noTranscript.stderr, "");
    assert.equal(run(t.call(file, { session_id: undefined })).status, 0);
  } finally {
    t.cleanup();
  }
});

test("a relative path is resolved against cwd", () => {
  const t = guidelineSetup();
  try {
    assert.equal(run(t.call(join("src", "ui.css"))).status, 2);
  } finally {
    t.cleanup();
  }
});

test("Write is stopped like Edit; Bash without a file and codex are not", () => {
  const t = guidelineSetup();
  const c = guidelineSetup();
  try {
    const file = join(t.repo, "src", "ui.css");
    assert.equal(run(t.call(file, { tool_name: "Write" })).status, 2);
    assert.equal(run(t.call(file, { tool_name: "Bash", tool_input: { command: "ls" } })).status, 0);
    assert.equal(run(c.call(join(c.repo, "src", "ui.css")), "codex").status, 0);
  } finally {
    t.cleanup();
    c.cleanup();
  }
});

test("the foreground watch block still returns 2", () => {
  const r = run({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "gh run watch 123" } });
  assert.equal(r.status, 2);
});
