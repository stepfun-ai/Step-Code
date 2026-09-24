#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const base = process.env.BASE_SHA ?? process.argv[2];
const head = process.env.HEAD_SHA ?? process.argv[3] ?? "HEAD";

if (!base) {
  console.error("Usage: check-commit-attribution.mjs <base-sha> [head-sha]");
  process.exit(2);
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

const range = `${base}..${head}`;
const commits = git(["rev-list", range]).trim().split(/\r?\n/).filter(Boolean);
const aiName = /^(?:claude(?:\s+code)?|codex|openai(?:\s+codex)?|chatgpt)(?:\s+\[bot\])?$/i;
const aiEmail = /@(?:anthropic\.com|openai\.com)$/i;
const trailer = /^\s*co-authored-by\s*:\s*(?<name>[^<]+?)\s*<(?<email>[^>]+)>\s*$/i;
const violations = [];

for (const sha of commits) {
  const record = git(["show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce%x00%B", sha]);
  const fields = record.split("\0");
  const authorName = fields[0]?.trim() ?? "";
  const authorEmail = fields[1]?.trim() ?? "";
  const committerName = fields[2]?.trim() ?? "";
  const committerEmail = fields[3]?.trim() ?? "";
  const message = fields.slice(4).join("\0");

  if (aiName.test(authorName) && aiEmail.test(authorEmail)) {
    violations.push(`${sha}: AI author ${authorName} <${authorEmail}>`);
  }
  if (aiName.test(committerName) && aiEmail.test(committerEmail)) {
    violations.push(`${sha}: AI committer ${committerName} <${committerEmail}>`);
  }

  for (const line of message.split(/\r?\n/)) {
    const match = line.match(trailer);
    if (match && aiName.test(match.groups.name.trim())) {
      violations.push(`${sha}: AI co-author ${match.groups.name.trim()} <${match.groups.email.trim()}>`);
    }
  }
}

if (violations.length > 0) {
  console.error("AI-client commit attribution is not allowed in this repository:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`Checked ${commits.length} commit(s); no AI-client attribution found.`);
