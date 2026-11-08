// Gathers every repo's LOG.md in a folder of repos into one list, newest first.
//   node log.mjs [folder] [word…] [--repo name] [--days N]
// The folder is the first argument that is a directory, else the current one; when run inside a repo,
// its parent. Words must all appear in an entry (any case). No network and no dependencies.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const HEADING = /^##\s+(\d{4}-\d{2}-\d{2})\b\s*[·:-]?\s*(.*)$/;

// An entry is a "## YYYY-MM-DD · title" heading and the lines up to the next "## " heading.
export function parseLog(text) {
  const entries = [];
  let entry = null;
  for (const line of String(text).replace(/^﻿/, "").split(/\r?\n/)) {
    const heading = line.match(HEADING);
    if (heading) {
      entry = { date: heading[1], title: heading[2].trim(), body: [] };
      entries.push(entry);
    } else if (/^##?\s/.test(line)) entry = null;
    else if (entry) entry.body.push(line);
  }
  for (const e of entries) e.body = e.body.join("\n").trim();
  return entries;
}

export function repoFolder(start) {
  const dir = resolve(start);
  return existsSync(join(dir, ".git")) ? dirname(dir) : dir;
}

export function collect(folder) {
  return readdirSync(folder, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(folder, d.name, "LOG.md")))
    .flatMap((d) => parseLog(readFileSync(join(folder, d.name, "LOG.md"), "utf8")).map((e) => ({ repo: d.name, ...e })))
    .sort((a, b) => b.date.localeCompare(a.date) || a.repo.localeCompare(b.repo));
}

export function filterEntries(entries, { words = [], repo = "", days = 0, now = new Date() } = {}) {
  const from = days > 0 ? new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10) : "";
  const lower = words.map((w) => w.toLowerCase());
  return entries.filter((e) => {
    if (repo && e.repo !== repo) return false;
    if (from && e.date < from) return false;
    const text = `${e.repo}\n${e.title}\n${e.body}`.toLowerCase();
    return lower.every((w) => text.includes(w));
  });
}

export function format(entries) {
  if (!entries.length) return "기록 없음";
  return entries.map((e) => `## ${e.date} · [${e.repo}] ${e.title}${e.body ? `\n${e.body}` : ""}`).join("\n\n");
}

export function parseArgs(argv) {
  const opts = { folder: "", words: [], repo: "", days: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") opts.repo = argv[++i] ?? "";
    else if (a === "--days") opts.days = Number(argv[++i]) || 0;
    else if (!opts.folder && !opts.words.length && existsSync(a) && statSync(a).isDirectory()) opts.folder = a;
    else opts.words.push(a);
  }
  return opts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const opts = parseArgs(process.argv.slice(2));
  const folder = repoFolder(opts.folder || process.cwd());
  const entries = filterEntries(collect(folder), opts);
  process.stdout.write(`${format(entries)}\n`);
  if (!entries.length) process.stderr.write(`(${basename(folder)} 아래 레포의 LOG.md에서 찾음)\n`);
}
