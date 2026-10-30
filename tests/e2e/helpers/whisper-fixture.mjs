#!/usr/bin/env node
// Deterministic process-boundary ASR fixture for the isolated mock e2e server.
// This never runs in the real generation server or claims to measure speech quality.
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const args = process.argv.slice(2);
if (args.includes("-h")) process.exit(0);
const index = args.indexOf("-of");
if (index < 0 || !args[index + 1]) throw new Error("fixture requires -of");
const input = args.at(-1);
const duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", input], { encoding: "utf8" }).trim());
if (!(duration > 0)) throw new Error("fixture input must contain audio");
const words = "Hello and welcome to the studio. Today we are testing a dubbed clip. Thanks for watching.".split(" ");
writeFileSync(args[index + 1] + ".json", JSON.stringify({ transcription: words.map((text, i) => ({ text, offsets: { from: Math.round(i * duration * 1000 / words.length), to: Math.round((i + 1) * duration * 1000 / words.length) } })) }));
