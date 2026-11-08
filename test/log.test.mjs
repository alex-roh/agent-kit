import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { collect, filterEntries, format, parseArgs, parseLog, repoFolder } from "../log.mjs";

const script = fileURLToPath(new URL("../log.mjs", import.meta.url));

function withRepos(logs, fn) {
  const dir = mkdtempSync(join(tmpdir(), "agent-kit-log-"));
  try {
    for (const [name, text] of Object.entries(logs)) {
      mkdirSync(join(dir, name, ".git"), { recursive: true });
      if (text !== null) writeFileSync(join(dir, name, "LOG.md"), text);
    }
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("parseLog reads dated headings and their lines, skipping the file title", () => {
  const text = "﻿# 기록\r\n\r\n## 2026-11-07 · 둘째\r\n- 바꾼 것: b\r\n\r\n## 2026-11-05 · 첫째\n- 알게 된 것: a\n## 메모\n- 날짜 없음\n";
  assert.deepEqual(parseLog(text), [
    { date: "2026-11-07", title: "둘째", body: "- 바꾼 것: b" },
    { date: "2026-11-05", title: "첫째", body: "- 알게 된 것: a" },
  ]);
});

test("collect merges repos newest first and skips repos without LOG.md", () => {
  withRepos({ a: "## 2026-11-01 · a1\n## 2026-11-06 · a2\n", b: "## 2026-11-03 · b1\n", c: null }, (dir) => {
    assert.deepEqual(
      collect(dir).map((e) => `${e.repo}:${e.title}`),
      ["a:a2", "b:b1", "a:a1"],
    );
  });
});

test("filterEntries matches every word in any case, repo and days", () => {
  const entries = [
    { repo: "life", date: "2026-11-07", title: "D1 마이그레이션", body: "- 알게 된 것: Wrangler 순서" },
    { repo: "vesper", date: "2026-10-01", title: "wrangler", body: "" },
  ];
  const now = new Date("2026-11-07T12:00:00Z");
  assert.equal(filterEntries(entries, { words: ["wrangler"] }).length, 2);
  assert.equal(filterEntries(entries, { words: ["wrangler", "순서"] }).length, 1);
  assert.equal(filterEntries(entries, { repo: "vesper" }).length, 1);
  assert.equal(filterEntries(entries, { days: 7, now }).length, 1);
});

test("format names the repo and says when nothing was found", () => {
  assert.equal(format([]), "기록 없음");
  assert.equal(format([{ repo: "r", date: "2026-11-07", title: "t", body: "- x" }]), "## 2026-11-07 · [r] t\n- x");
});

test("parseArgs takes a leading folder, words and options", () => {
  const dir = tmpdir();
  assert.deepEqual(parseArgs([dir, "훅", "--repo", "life", "--days", "30"]), {
    folder: dir,
    words: ["훅"],
    repo: "life",
    days: 30,
  });
  assert.equal(parseArgs(["훅"]).folder, "");
});

test("run inside a repo, the script reads its sibling repos", () => {
  withRepos({ a: "## 2026-11-07 · 훅 고침\n", b: "## 2026-11-06 · 다른 일\n" }, (dir) => {
    assert.equal(repoFolder(join(dir, "a")), dir);
    const out = spawnSync(process.execPath, [script, "훅"], { cwd: join(dir, "a"), encoding: "utf8" });
    assert.equal(out.status, 0);
    assert.equal(out.stdout.trim(), "## 2026-11-07 · [a] 훅 고침");
  });
});
