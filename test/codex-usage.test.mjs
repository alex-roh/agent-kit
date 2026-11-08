import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windows, line, readUsage } from "../codex-usage.mjs";

const RESULT = {
  rateLimits: {
    primary: { usedPercent: 42.4, windowDurationMins: 300, resetsAt: null },
    secondary: { usedPercent: 17, windowDurationMins: 10080, resetsAt: null },
  },
};

test("reads the 5-hour and weekly windows from the answer", () => {
  assert.equal(line(windows(RESULT)), "Codex 사용량: 5시간 42% · 주간 17%");
  assert.equal(line(windows({ nested: { a: { used_percent: 5, window_minutes: 300 } } })), "Codex 사용량: 5시간 5%");
  assert.equal(line(windows({ nothing: 1 })), "");
});

test("talks to a fake app-server in the initialize → initialized → read order", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-usage-"));
  const bin = join(dir, "codex");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
let seen = [];
require("readline").createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l); seen.push(m.method);
  if (m.method === "initialize") console.log(JSON.stringify({ id: 0, result: {} }));
  if (m.method === "account/rateLimits/read")
    console.log(JSON.stringify(seen.join(",") === "initialize,initialized,account/rateLimits/read"
      ? { id: 1, result: ${JSON.stringify(RESULT)} } : { id: 1, error: { message: seen.join(",") } }));
});
`,
  );
  chmodSync(bin, 0o755);
  const r = await readUsage({ bin, timeoutMs: 5000 });
  assert.equal(line(windows(r)), "Codex 사용량: 5시간 42% · 주간 17%");
});
