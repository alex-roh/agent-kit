// The one hook every repo's settings call: `node hook.mjs claude` or `node hook.mjs codex`.
// It puts the rules and the repo's to-do list in a new session, says when to hand work to subagents and when a new session could pay off, blocks watching a GitHub
// run or sleeping in the foreground, and notes the UI guideline once on the first edit of a screen file. No
// network and no dependencies: the session start command in settings.json downloads this file and
// RULES.md. A failure here never stops the agent.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// How full the context was at the last model call, or 0 right after a compaction (the old size no
// longer holds) or when the tail has no call. Subagent rows are skipped: they have their own context.
export function contextTokens(jsonl) {
  const lines = jsonl.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes('"isCompactSummary":true')) return 0;
    if (!lines[i].includes('"usage"')) continue;
    try {
      const row = JSON.parse(lines[i]);
      const u = row.message?.usage;
      if (row.type !== "assistant" || row.isSidechain || !u) continue;
      return (
        (u.input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0)
      );
    } catch {}
  }
  return 0;
}

// Measured 2026-11-03 (median): a new session reaches about 164K tokens at its first edit and costs
// about $3 to get there; reading a token of context costs $0.5 per million each turn. So a new session
// pays back $3 / ((context - 164K) * $0.5/M) turns later. Below 200K that is over 160 turns: stay silent.
const NEW_SESSION_DOLLARS = 3;
const NEW_SESSION_TOKENS = 164_000;
const READ_DOLLARS_PER_TOKEN = 0.5 / 1e6;
const CONTEXT_NOTE_FROM = 200_000;

export function contextNote(tokens) {
  if (tokens < CONTEXT_NOTE_FROM) return "";
  const turns = Math.ceil(
    NEW_SESSION_DOLLARS / ((tokens - NEW_SESSION_TOKENS) * READ_DOLLARS_PER_TOKEN),
  );
  return `[문맥] ${Math.round(tokens / 10_000)}만 토큰. 새 세션은 약 ${turns}턴 더 일해야 본전이다. 이번 요청이 지금까지와 다른 주제이고 그보다 오래 걸릴 일이면 답 첫 줄에 새 세션을 권한다. 아니면 이 글을 언급하지 않는다.`;
}

// A note stays in the context and is read again every turn, so it is said once per 50K band. A
// compaction lowers the band, so crossing it again speaks again.
export function contextBand(tokens) {
  return tokens < CONTEXT_NOTE_FROM ? 0 : Math.floor(tokens / 50_000) * 50_000;
}

// From 100K a turn of mine costs more than a subagent's start (about 40K), so work of five turns or more should go to one.
// Knowing the rule was not enough: in the middle of work "this is quick" always looks right (life, 2026-11-10). Said once,
// and again only after a compaction brings the context back under it.
const DELEGATE_NOTE_FROM = 100_000;
export const DELEGATE_NOTE = "[문맥] 10만 토큰을 넘었다. 이제 내 턴이 서브에이전트 시작(약 4만)보다 비싸다. 끝이 분명하고 5턴 넘을 일(브라우저로 읽기, 반복 기록, 긴 로그 정리, 테스트 쓰기·고치기, 재기, 넓은 찾기)은 Sonnet 서브에이전트에 맡기고, 판단과 커밋·배포·운영 DB 쓰기는 직접 한다. 이 글은 언급하지 않는다.";

export function delegateNote(tokens, said) {
  if (tokens < DELEGATE_NOTE_FROM) return { text: "", said: false };
  return { text: said ? "" : DELEGATE_NOTE, said: true };
}

// Only a transcript's end, so a long session does not slow every prompt.
function fileTail(path) {
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const length = Math.min(size, 400_000);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function contextNoteFor(path, session) {
  if (!path || !session) return "";
  const tokens = contextTokens(fileTail(path));
  const id = String(session).replace(/\W/g, "");
  const delegateFile = join(tmpdir(), `agent-kit-delegate-${id}`);
  const delegate = delegateNote(tokens, existsSync(delegateFile));
  if (delegate.said && !existsSync(delegateFile)) writeFileSync(delegateFile, "");
  else if (!delegate.said && existsSync(delegateFile)) rmSync(delegateFile);
  const band = contextBand(tokens);
  const file = join(tmpdir(), `agent-kit-context-${id}`);
  const said = existsSync(file) ? Number(readFileSync(file, "utf8")) || 0 : 0;
  let note = "";
  if (band !== said) {
    writeFileSync(file, String(band));
    if (band > said) note = contextNote(tokens);
  }
  return [delegate.text, note].filter(Boolean).join("\n\n");
}

// Heredocs and quoted text are what a command writes, not what it runs: a document that only mentions
// the command was blocked on 2026-11-03.
export function commandOnly(command) {
  return String(command)
    .replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s*\2(?=\s|$)/g, " ")
    .replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
}

// Waiting in front of a run took most of a session's time; in the background a notice comes when it ends.
export function isForegroundWatch(toolInput) {
  if (toolInput?.run_in_background) return false;
  return /\bgh\s+(run\s+watch|pr\s+checks\b[^;&|\n]*--watch)/.test(commandOnly(toolInput?.command ?? ""));
}

// Measured 2026-11-04: the sleep rule alone left 25 foreground waits of about 20 to 90 seconds in a day.
// Under 5 seconds is a short retry, not waiting for work. Only a sleep in command position counts.
const SLEEP_UNIT_SECONDS = { "": 1, s: 1, m: 60, h: 3600, d: 86400 };
const SLEEP_FROM_SECONDS = 5;

export function isForegroundSleep(toolInput) {
  if (toolInput?.run_in_background) return false;
  const sleeps = commandOnly(toolInput?.command ?? "").matchAll(
    /(?:^|[;&|\n({]|\b(?:do|then|else)\s)\s*(?:sleep|start-sleep)(?:\s+-s\w*)?\s+(\d+(?:\.\d+)?)([smhd]?)(?=[\s;&|)}]|$)/gi,
  );
  return [...sleeps].some(
    ([, amount, unit]) => Number(amount) * SLEEP_UNIT_SECONDS[unit.toLowerCase()] >= SLEEP_FROM_SECONDS,
  );
}

const GUIDELINE = join("vendor", "ui-kit", "GUIDELINES.md");

// Measured 2026-11-04 on the repos that vendor ui-kit. A plain substring also caught guide, build, quiz
// and continuity, and path words also caught docs and data, so words count only on code files. The path
// is relative to the repo: a folder name such as worker-kit says nothing about the file.
export function isScreenFile(path) {
  const p = String(path).replaceAll("\\", "/").toLowerCase();
  if (/(^|\/)(vendor|tests?)\/|\.test\./.test(p)) return false;
  // Screens the kit does not draw (watch, desk and widget apps, design mockups): the UI guideline says nothing to them.
  if (/(^|\/)(watch|wear|desk|widget|android|ios|design|mockups?)\//.test(p)) return false;
  if (/\.(css|html|tsx|jsx)$/.test(p)) return true;
  return (
    /\.(js|mjs|ts)$/.test(p) &&
    /(^|[/._-])(ui|kit|pages?|render\w*)($|[/._-])|(^|\/)admin-|(^|\/)(site|web)\/src\//.test(p)
  );
}

// A Read counts, and so does a shell read of the file (cat, sed, head, Get-Content, `map.mjs 절` — life's AGENTS.md
// sends big docs through 절, and a hook that ignored it made a session resend a 15KB write, 2026-11-08).
// grep and mentions do not count: the rules text names this path too. A compaction drops what was read.
const GUIDELINE_PATH = /(^|[\\/\s"'])vendor[\\/]ui-kit[\\/]GUIDELINES\.md(?=$|[\s"'])/i;
const SHELL_READ = /(^|[\s;&|(])(cat|sed|head|tail|less|more|type|Get-Content|gc)\s|map\.mjs\s+절\s/i;
const readsGuideline = (c) =>
  c.type === "tool_use" &&
  ((c.name === "Read" && /(^|[\\/])vendor[\\/]ui-kit[\\/]GUIDELINES\.md$/i.test(c.input?.file_path ?? "")) ||
    (c.name === "Bash" && GUIDELINE_PATH.test(c.input?.command ?? "") && SHELL_READ.test(c.input?.command ?? "")));
export function readGuideline(jsonl) {
  const lines = jsonl.slice(jsonl.lastIndexOf('"isCompactSummary":true') + 1).split("\n");
  return lines.some((line) => {
    if (!line.includes("GUIDELINES.md")) return false;
    try {
      const content = JSON.parse(line).message?.content;
      return Array.isArray(content) && content.some(readsGuideline);
    } catch {
      return false;
    }
  });
}

function repoWithGuideline(file) {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    if (existsSync(join(dir, GUIDELINE))) return dir;
    if (dir === dirname(dir)) return "";
  }
}

// A note once per session, not a stop: a light edit (wording, a bug) needs no guideline at all (사용자, 2026-11-09).
export function guidelineNote({ tool_name, tool_input, transcript_path, session_id, cwd }) {
  if (!/^(Edit|Write)$/.test(tool_name) || !tool_input?.file_path || !transcript_path || !session_id) return "";
  const file = resolve(cwd ?? ".", tool_input.file_path);
  const repo = repoWithGuideline(file);
  if (!repo || !isScreenFile(relative(repo, file))) return "";
  const said = join(tmpdir(), `agent-kit-guideline-${String(session_id).replace(/\W/g, "")}`);
  if (existsSync(said) || readGuideline(readFileSync(transcript_path, "utf8"))) return "";
  writeFileSync(said, "");
  return `화면을 새로 짜거나 모양을 바꾸는 일이면 ${join(repo, GUIDELINE)} 의 0절('좋은 화면')만 읽는다. 문구·버그·데이터 수정이면 읽지 않는다.`;
}

export function rulesText(path = join(homedir(), ".agent-kit", "RULES.md")) {
  if (!existsSync(path)) return "";
  const rules = readFileSync(path, "utf8").trim();
  return rules && `[공통 규칙] agent-kit RULES.md 최신본이다. 이대로 따른다.\n\n${rules}`;
}

// A repo's TODO.md has "# 지금" and "# 나중". Only 지금 is read out, so long-term items stay out of the
// context; 나중 is a count. Items before any such heading count as 지금.
const TODO_SHOWN = 5;
const TODO_ITEM_CHARS = 100;
const TODO_OLD_DAYS = 30;

export function parseTodo(text) {
  const items = { now: [], later: [] };
  let section = "now";
  for (const line of String(text).replace(/^﻿/, "").split(/\r?\n/)) {
    const heading = line.match(/^#+\s*(지금|나중)/);
    if (heading) section = heading[1] === "지금" ? "now" : "later";
    else if (/^- \S/.test(line)) items[section].push(line.slice(2).trim());
  }
  return items;
}

// An item ends in "(MM-DD)". The year is not written, so a date still ahead means last year.
export function isOldTodo(item, now = new Date()) {
  const date = item.match(/\((\d{2})-(\d{2})\)$/);
  if (!date) return false;
  const written = new Date(now.getFullYear(), Number(date[1]) - 1, Number(date[2]));
  if (written > now) written.setFullYear(written.getFullYear() - 1);
  // Whole days: the hour of the day and a clock change must not tip day 30 over.
  return Math.floor((now - written) / 86_400_000) > TODO_OLD_DAYS;
}

export function repoTodoText(text, now = new Date()) {
  const { now: current, later } = parseTodo(text);
  if (!current.length && !later.length) return "";
  const shown = current
    .slice(0, TODO_SHOWN)
    .map((item) => `- ${item.slice(0, TODO_ITEM_CHARS)}${isOldTodo(item, now) ? " [오래됨]" : ""}`);
  const rest = [
    current.length > TODO_SHOWN && `지금 칸 외 ${current.length - TODO_SHOWN}개`,
    later.length > 0 && `나중 ${later.length}개`,
  ].filter(Boolean);
  return [
    "[할 일] 이 레포 TODO.md다. 첫 답 맨 앞에 한 줄로 알린다. [오래됨] 항목은 지울지 나중으로 옮길지 묻는다.",
    ...shown,
    ...(rest.length ? [`(${rest.join(", ")})`] : []),
  ].join("\n");
}

function readTodo(dir) {
  const file = join(dir, "TODO.md");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

// In a repo (or below it) that repo's list; in a folder of repos a count per repo, since which repo
// the work is in is not known yet. Folders without .git are skipped: vendor copies are not lists.
export function todoText(cwd, now = new Date()) {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return repoTodoText(readTodo(dir), now);
    if (dir === dirname(dir)) break;
  }
  const counts = readdirSync(cwd, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(cwd, entry.name, ".git")))
    .map((entry) => {
      const { now: current, later } = parseTodo(readTodo(join(cwd, entry.name)));
      return current.length || later.length ? `${entry.name} 지금 ${current.length}·나중 ${later.length}` : "";
    })
    .filter(Boolean);
  return counts.length
    ? `[할 일] 레포별 TODO.md: ${counts.join(", ")}. 첫 답 맨 앞에 한 줄로 알린다. 작업할 레포를 정하면 그 레포 TODO.md의 지금 칸을 읽어 알린다.`
    : "";
}

// Codex reads stdout starting with "[" or "{" as JSON and would drop plain text, so it gets JSON.
function say(tool, event, text) {
  if (!text) return;
  process.stdout.write(
    tool === "codex"
      ? `${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } })}\n`
      : `${text}\n`,
  );
}

function main(tool) {
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  const event = input.hook_event_name;
  if (event === "SessionStart") {
    // A resumed session already holds the rules; after a compaction it has lost them.
    if (input.source === "resume") return;
    // The list is said once when work starts, not again after a compaction. A broken list must not lose the rules.
    let todo = "";
    if (input.source !== "compact") {
      try {
        todo = todoText(input.cwd ?? process.cwd());
      } catch {}
    }
    say(tool, event, [rulesText(), todo].filter(Boolean).join("\n\n"));
  } else if (event === "UserPromptSubmit") {
    // Codex transcripts have another shape.
    if (tool === "claude") say(tool, event, contextNoteFor(input.transcript_path, input.session_id));
  } else if (event === "PreToolUse") {
    const stop = isForegroundWatch(input.tool_input)
      ? "GitHub 실행을 앞에서 지켜보지 않는다. run_in_background로 걸면 끝날 때 알림이 온다.\n"
      : isForegroundSleep(input.tool_input)
        ? "sleep으로 앞에서 기다리지 않는다. 기다릴 명령을 run_in_background로 걸면 끝날 때 알림이 온다.\n"
        : "";
    if (stop) {
      process.stderr.write(stop);
      process.exitCode = 2;
    } else if (tool === "claude") {
      const note = guidelineNote(input);
      if (note) process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: note } })}\n`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv[2] || "claude");
  } catch {
    process.exitCode = 0;
  }
}
