#!/usr/bin/env node
/**
 * Privacy guard (AGENTS.md §3).
 *
 * The repository is PUBLIC. Every committed byte is world-readable forever,
 * including anything later deleted, because git history is cloned and mirrored.
 *
 * This script fails the build if a commit would introduce plaintext financial
 * data. It is deliberately conservative: a false positive costs one allowlist
 * entry, a false negative leaks the user's spending history permanently.
 *
 * Usage:  node scripts/check-no-plaintext.mjs
 * Exit:   0 = clean, 1 = violations found
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Extensions that a platform export, archive or encrypted blob could carry. */
const FORBIDDEN_EXT = new Set([
  '.csv', '.tsv', '.txt', '.xls', '.xlsx', '.zip',
  '.pdf', '.eml', '.enc', '.jsonl', '.sqlite', '.db',
]);

/**
 * Synthetic fixtures are the ONLY place tabular financial-looking data is
 * allowed, and only because AGENTS.md §3 rule 4 requires them to be fabricated.
 */
const ALLOWED_PATHS = [
  /^src\/tests\/fixtures\//,
  /^public\//,
];

/** Never scanned: generated, vendored, or too noisy to reason about. */
const SKIP_PATHS = [
  /^node_modules\//,
  /^dist\//,
  /^coverage\//,
  /^\.git\//,
  /package-lock\.json$/,
  /\.min\.(js|css)$/,
  /^scripts\/check-no-plaintext\.mjs$/, // contains the patterns themselves
];

/**
 * Source code is exempt from the statement-like heuristic, but NOT from the PII
 * checks.
 *
 * Tests and fixtures legitimately contain dates, amounts and commas — that is
 * what they assert against. A real statement export never arrives as a `.ts`
 * file, and the extensions one CAN arrive as are already hard-blocked above, so
 * running the heuristic here produces noise that would train the user to ignore
 * the check. It still runs on `.md`, `.json`, `.yml` and similar, where a pasted
 * statement is a genuine risk.
 */
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css']);

/** High-confidence personally identifying numbers. */
const PII_PATTERNS = [
  { name: 'Chinese resident ID (18 digits)', re: /(?<!\d)\d{17}[\dXx](?!\d)/ },
  { name: 'Bank card / account number (16-19 digits)', re: /(?<![\d.])\d{16,19}(?![\d.])/ },
];

/** A text file that looks like a real statement export. */
const DATE_RE = /20\d{2}\s*[-/年]\s*\d{1,2}\s*[-/月]\s*\d{1,2}/;
const AMOUNT_RE = /\d+\.\d{2}/;
const STATEMENT_ROW_THRESHOLD = 3;

const violations = [];
const toPosix = (p) => p.split('\\').join('/');

function isAllowed(relPath) {
  return ALLOWED_PATHS.some((re) => re.test(relPath));
}

function isSkipped(relPath) {
  return SKIP_PATHS.some((re) => re.test(relPath));
}

/** Prefer git's own view of the repo so .gitignore is honoured. */
function listFiles() {
  const out = [];
  const collect = (args) => {
    try {
      const raw = execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return raw.split('\0').filter(Boolean);
    } catch {
      return null;
    }
  };

  const staged = collect(['diff', '--cached', '--name-only', '-z']);
  const tracked = collect(['ls-files', '-z']);
  if (staged === null && tracked === null) return null; // not a git repo
  for (const f of [...(staged ?? []), ...(tracked ?? [])]) out.push(toPosix(f));
  return [...new Set(out)];
}

/** Fallback when there is no git repo: walk the tree, minus vendored dirs. */
function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    const relPath = toPosix(abs.slice(ROOT.length + 1));
    if (isSkipped(relPath)) continue;
    if (entry.isDirectory()) found.push(...walk(abs));
    else if (entry.isFile()) found.push(relPath);
  }
  return found;
}

function isProbablyBinary(buf) {
  const sample = buf.subarray(0, 8000);
  for (const byte of sample) if (byte === 0) return true;
  return false;
}

function checkFile(relPath) {
  const abs = join(ROOT, relPath);
  let st;
  try {
    st = statSync(abs);
  } catch {
    return; // staged-but-deleted
  }
  if (!st.isFile()) return;

  const ext = extname(relPath).toLowerCase();
  const allowed = isAllowed(relPath);

  if (FORBIDDEN_EXT.has(ext) && !allowed) {
    violations.push({
      file: relPath,
      rule: 'forbidden extension',
      detail: `"${ext}" may contain real statement data. Move it under src/tests/fixtures/ and confirm it is synthetic, or remove it.`,
    });
    return;
  }

  if (st.size > 5 * 1024 * 1024) return; // too large to scan

  let buf;
  try {
    buf = readFileSync(abs);
  } catch {
    return;
  }
  if (isProbablyBinary(buf)) return;

  const text = buf.toString('utf8');

  for (const { name, re } of PII_PATTERNS) {
    const m = text.match(re);
    if (m) {
      violations.push({
        file: relPath,
        rule: 'PII pattern',
        detail: `${name} found: "${m[0].slice(0, 6)}${'*'.repeat(Math.max(0, m[0].length - 6))}". Real identifiers must never be committed.`,
      });
    }
  }

  if (allowed) return; // synthetic fixtures may legitimately contain fake amounts

  // Source files are covered by the extension and PII rules above; see CODE_EXT.
  if (CODE_EXT.has(ext)) return;

  const statementRows = text
    .split(/\r?\n/)
    .filter((line) => DATE_RE.test(line) && AMOUNT_RE.test(line)).length;

  if (statementRows >= STATEMENT_ROW_THRESHOLD) {
    violations.push({
      file: relPath,
      rule: 'statement-like content',
      detail: `${statementRows} lines look like dated transaction rows with amounts. This is characteristic of a real bank/platform export.`,
    });
  }
}

/**
 * Choose the file list to scan.
 *
 * `git ls-files` honours .gitignore, which is what we want. But it is empty in
 * a freshly-initialised repo, and scanning zero files would make the check pass
 * vacuously — the worst possible outcome for a safety net. So an empty result
 * falls back to walking the tree.
 */
function filesToScan() {
  const listed = listFiles();
  if (listed && listed.length > 0) return { files: listed, source: 'git index' };
  return { files: walk(ROOT), source: 'filesystem walk' };
}

const { files, source } = filesToScan();
for (const f of files) {
  if (isSkipped(f)) continue;
  checkFile(f);
}

if (violations.length > 0) {
  console.error('\n\u274c  check:no-plaintext FAILED \u2014 this commit would publish financial data.\n');
  for (const v of violations) {
    console.error(`  ${v.file}\n    \u2514\u2500 ${v.rule}: ${v.detail}\n`);
  }
  console.error('This repository is PUBLIC. Anything committed here is world-readable forever,');
  console.error('including after deletion, because git history is cloned and mirrored.\n');
  console.error('See AGENTS.md \u00a73 for the privacy invariants.\n');
  process.exit(1);
}

console.log(`\u2705  check:no-plaintext passed \u2014 scanned ${files.length} file(s) via ${source}, no plaintext financial data found.`);
