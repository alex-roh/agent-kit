import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  commandOnly,
  contextBand,
  contextNote,
  contextTokens,
  isForegroundWatch,
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
