#!/usr/bin/env node
/* Denylist scanner: checks every git-tracked text file for whole-word matches
   of the terms in $OF_DENYLIST (default ~/.motionfield/denylist.txt).

   Denylist format: one term per line; '#' starts a comment;
   "@allow-in=<path> <term>" permits that term only in that file.

   Output prints path:line and the numeric term index — never the term itself.
   --baseline <file> reads "path<TAB>sha1(lowercased term)" pairs; hits that
   appear in the baseline are WARN, not failures.
   --write-baseline <file> regenerates that file from the current tree.

   Exit: 2 = denylist missing, 1 = non-baselined hits, 0 = clean. */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
let baselinePath = null;
let writeBaselinePath = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--baseline") baselinePath = args[++i];
  else if (args[i] === "--write-baseline") writeBaselinePath = args[++i];
}

const denyPath = process.env.OF_DENYLIST || join(homedir(), ".motionfield", "denylist.txt");
if (!existsSync(denyPath)) {
  console.error(`check-names: denylist not found at ${denyPath}`);
  process.exit(2);
}

/** Ordered deny terms; index is what we print, never the text. */
const terms = [];
const termIndex = new Map();
const indexOf = (t) => {
  const key = t.toLowerCase();
  if (!termIndex.has(key)) {
    termIndex.set(key, terms.length);
    terms.push(t);
  }
  return termIndex.get(key);
};
/** termIndex -> Set<path> where that term is permitted. */
const allowed = new Map();

for (const raw of readFileSync(denyPath, "utf8").split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const m = line.match(/^@allow-in=(\S+)\s+(.+)$/);
  if (m) {
    const idx = indexOf(m[2]);
    if (!allowed.has(idx)) allowed.set(idx, new Set());
    allowed.get(idx).add(m[1]);
  } else {
    indexOf(line);
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const patterns = terms.map((t) => new RegExp(`(?<![\\w])${escapeRe(t)}(?![\\w])`, "i"));
const sha1 = (s) => createHash("sha1").update(s, "utf8").digest("hex");

const baseline = new Set();
if (baselinePath) {
  if (existsSync(baselinePath)) {
    for (const raw of readFileSync(baselinePath, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      baseline.add(line);
    }
  }
}

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => f && f !== "package-lock.json" && !f.startsWith("node_modules/"));

/** @type {{path:string,line:number,term:number,inBase:boolean}[]} */
const hits = [];
for (const file of tracked) {
  let buf;
  try {
    buf = readFileSync(file);
  } catch {
    continue; // unreadable (e.g. dangling symlink)
  }
  if (buf.includes(0)) continue; // binary
  const lines = buf.toString("utf8").split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    for (let ti = 0; ti < patterns.length; ti++) {
      if (!patterns[ti].test(lines[ln])) continue;
      if (allowed.get(ti)?.has(file)) continue;
      hits.push({ path: file, line: ln + 1, term: ti, inBase: baseline.has(`${file}\t${sha1(terms[ti].toLowerCase())}`) });
    }
  }
}

if (writeBaselinePath) {
  const pairs = [...new Set(hits.map((h) => `${h.path}\t${sha1(terms[h.term].toLowerCase())}`))].sort();
  writeFileSync(writeBaselinePath, pairs.map((p) => p + "\n").join(""));
  console.log(`check-names: wrote ${pairs.length} baseline entries to ${writeBaselinePath}`);
}

const failures = hits.filter((h) => !h.inBase);
for (const h of hits) {
  console.log(`${h.inBase ? "WARN" : "FAIL"} ${h.path}:${h.line} term#${h.term}`);
}
if (!hits.length) console.log("check-names: clean");
process.exit(failures.length ? 1 : 0);
