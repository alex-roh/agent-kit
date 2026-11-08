// Codex 사용량 한 줄: `node agent-kit/codex-usage.mjs` (레포들이 모인 폴더에서). Codex에 맡기기 전에 이 결과를 보이고 허락받는다(RULES.md "일하기").
// codex app-server에 JSON-RPC(줄마다 JSON 하나)로 initialize → initialized → account/rateLimits/read를 보내고 5시간·주간 사용률을 적는다.
// --raw는 받은 결과를 그대로 찍는다(응답 모양이 바뀌었을 때 보는 용도). CODEX_BIN으로 실행 파일을 바꿀 수 있다(테스트용).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Finds the windows in whatever shape the server answers: {rateLimits:{primary,secondary}} or the same keys deeper.
export function windows(result) {
  const out = [];
  const walk = (v, key) => {
    if (!v || typeof v !== "object") return;
    const pct = v.usedPercent ?? v.used_percent;
    if (typeof pct === "number") {
      const mins = v.windowDurationMins ?? v.window_minutes ?? v.windowMinutes;
      const resets = v.resetsAt ?? v.resets_at;
      out.push({ key, pct, mins, resets });
      return;
    }
    for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(result, "");
  return out;
}

const span = (w) =>
  w.mins == null ? w.key : w.mins <= 300 ? "5시간" : w.mins >= 7 * 24 * 60 - 60 ? "주간" : `${Math.round(w.mins / 60)}시간`;
const at = (r) => {
  if (r == null) return "";
  const d = new Date(typeof r === "number" ? (r < 1e12 ? r * 1000 : r) : r);
  return Number.isNaN(d.getTime()) ? "" : ` (${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} 초기화)`;
};
export const line = (ws) => (ws.length ? `Codex 사용량: ${ws.map((w) => `${span(w)} ${Math.round(w.pct)}%${at(w.resets)}`).join(" · ")}` : "");

export function readUsage({ bin = process.env.CODEX_BIN || "codex", timeoutMs = 20000 } = {}) {
  return new Promise((done, fail) => {
    const child = spawn(bin, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" });
    let buf = "", err = "";
    const stop = (fn, v) => { clearTimeout(timer); child.kill(); fn(v); };
    const timer = setTimeout(() => stop(fail, new Error(`codex app-server가 ${timeoutMs / 1000}초 안에 답하지 않음${err ? `: ${err.trim().slice(0, 200)}` : ""}`)), timeoutMs);
    const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
    child.on("error", (e) => stop(fail, new Error(`codex를 못 띄움: ${e.message}`)));
    child.stderr.on("data", (d) => { err += d; });
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const raw = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!raw) continue;
        let m;
        try { m = JSON.parse(raw); } catch { continue; }
        if (m.id === 0) {
          if (m.error) return stop(fail, new Error(`initialize 실패: ${JSON.stringify(m.error)}`));
          send({ method: "initialized" });
          send({ method: "account/rateLimits/read", id: 1 });
        } else if (m.id === 1) {
          if (m.error) return stop(fail, new Error(`사용량 읽기 실패: ${JSON.stringify(m.error)}`));
          return stop(done, m.result);
        }
      }
    });
    send({ method: "initialize", id: 0, params: { clientInfo: { name: "agent-kit", title: "agent-kit codex-usage", version: "1" } } });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  readUsage()
    .then((r) => {
      const text = line(windows(r));
      console.log(process.argv.includes("--raw") || !text ? JSON.stringify(r, null, 2) : text);
    })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
