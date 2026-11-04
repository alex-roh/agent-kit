// The one hook every repo's settings call: `node hook.mjs claude` or `node hook.mjs codex`.
// It puts the rules in a new session, says when a new session could pay off, blocks watching a GitHub
// run or sleeping in the foreground, and stops the first edit of a screen file until the UI guideline is read. No
// network and no dependencies: the session start command in settings.json downloads this file and
// RULES.md. A failure here never stops the agent.
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
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
  const band = contextBand(tokens);
  const file = join(tmpdir(), `agent-kit-context-${String(session).replace(/\W/g, "")}`);
  const said = existsSync(file) ? Number(readFileSync(file, "utf8")) || 0 : 0;
  if (band === said) return "";
  writeFileSync(file, String(band));
  return band > said ? contextNote(tokens) : "";
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
  if (/\.(css|html|tsx|jsx)$/.test(p)) return true;
  return (
    /\.(js|mjs|ts)$/.test(p) &&
    /(^|[/._-])(ui|kit|pages?|render\w*)($|[/._-])|(^|\/)admin-|(^|\/)(site|web)\/src\//.test(p)
  );
}

// Only a Read counts: the rules text names this path too. A compaction drops what was read.
export function readGuideline(jsonl) {
  const lines = jsonl.slice(jsonl.lastIndexOf('"isCompactSummary":true') + 1).split("\n");
  return lines.some((line) => {
    if (!line.includes("GUIDELINES.md")) return false;
    try {
      const content = JSON.parse(line).message?.content;
      return (
        Array.isArray(content) &&
        content.some(
          (c) =>
            c.type === "tool_use" &&
            c.name === "Read" &&
            /(^|[\\/])vendor[\\/]ui-kit[\\/]GUIDELINES\.md$/i.test(c.input?.file_path ?? ""),
        )
      );
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

// Stops once per session: on a second try the agent has judged the edit is not screen work.
function guidelineStop({ tool_name, tool_input, transcript_path, session_id, cwd }) {
  if (!/^(Edit|Write)$/.test(tool_name) || !tool_input?.file_path || !transcript_path || !session_id) return "";
  const file = resolve(cwd ?? ".", tool_input.file_path);
  const repo = repoWithGuideline(file);
  if (!repo || !isScreenFile(relative(repo, file))) return "";
  const said = join(tmpdir(), `agent-kit-guideline-${String(session_id).replace(/\W/g, "")}`);
  if (existsSync(said) || readGuideline(readFileSync(transcript_path, "utf8"))) return "";
  writeFileSync(said, "");
  return `화면 파일을 고치기 전에 ${join(repo, GUIDELINE)} 를 Read로 읽는다. 화면 일이 아니면 그대로 다시 시도한다.\n`;
}

export function rulesText(path = join(homedir(), ".agent-kit", "RULES.md")) {
  if (!existsSync(path)) return "";
  const rules = readFileSync(path, "utf8").trim();
  return rules && `[공통 규칙] agent-kit RULES.md 최신본이다. 이대로 따른다.\n\n${rules}`;
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
    if (input.source !== "resume") say(tool, event, rulesText());
  } else if (event === "UserPromptSubmit") {
    // Codex transcripts have another shape.
    if (tool === "claude") say(tool, event, contextNoteFor(input.transcript_path, input.session_id));
  } else if (event === "PreToolUse") {
    const stop = isForegroundWatch(input.tool_input)
      ? "GitHub 실행을 앞에서 지켜보지 않는다. run_in_background로 걸면 끝날 때 알림이 온다.\n"
      : isForegroundSleep(input.tool_input)
        ? "sleep으로 앞에서 기다리지 않는다. 기다릴 명령을 run_in_background로 걸면 끝날 때 알림이 온다.\n"
        : tool === "claude" && guidelineStop(input);
    if (stop) {
      process.stderr.write(stop);
      process.exitCode = 2;
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
