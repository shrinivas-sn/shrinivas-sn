// Refreshes the three numbers on assets/stats.svg from the GitHub GraphQL API.
//
//   node .github/scripts/stats-card.mjs [--dry-run] [--svg PATH]
//
// Env: GITHUB_TOKEN (required), STATS_USER (default shrinivas-sn),
//      GITHUB_GRAPHQL_URL (default https://api.github.com/graphql),
//      STATS_TIMEOUT_MS (default 15000), STATS_RETRY_MS (default 2000).
// Any failure prints the reason on stderr, exits 1 and leaves the card untouched.

import fs from "node:fs";
import path from "node:path";

const USER = process.env.STATS_USER || "shrinivas-sn";
const URL_ = process.env.GITHUB_GRAPHQL_URL || "https://api.github.com/graphql";
const TIMEOUT_MS = Number(process.env.STATS_TIMEOUT_MS || 15000);
const RETRY_MS = Number(process.env.STATS_RETRY_MS || 2000);
const TRIES = 3;

const QUERY = `query($login: String!) {
  user(login: $login) {
    pullRequests(states: MERGED) { totalCount }
    issues { totalCount }
    repositoriesContributedTo(first: 1, contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY]) { totalCount }
  }
}`;

class StatsError extends Error {}
const fail = (msg) => { throw new StatsError(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One try. Returns { retry: true, reason } for a timeout, network error or 5xx; throws for anything final. */
async function ask(token) {
  let res;
  try {
    res = await fetch(URL_, {
      method: "POST",
      headers: { authorization: `bearer ${token}`, "content-type": "application/json", "user-agent": "profile-stats-card" },
      body: JSON.stringify({ query: QUERY, variables: { login: USER } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err && (err.name === "TimeoutError" || err.name === "AbortError");
    return { retry: true, reason: timedOut ? `timed out after ${TIMEOUT_MS} ms (no answer)` : `request failed: ${err && err.cause && err.cause.code ? err.cause.code : err.message}` };
  }
  if (res.status >= 500) return { retry: true, reason: `GitHub API answered HTTP ${res.status}` };
  let text;
  try {
    text = await res.text();
  } catch (err) {
    return { retry: true, reason: `reply was cut off (${err.message})` };
  }
  if (res.status >= 400) fail(`GitHub API answered HTTP ${res.status}: ${text.slice(0, 200).replace(/\s+/g, " ")}`);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    fail("GitHub API reply is not JSON");
  }
  if (Array.isArray(body.errors) && body.errors.length) fail(`GitHub API returned errors: ${body.errors.map((e) => e && e.message).filter(Boolean).join("; ") || "unknown"}`);
  const u = body && body.data && body.data.user;
  if (!u) fail("GitHub API reply has no data.user");
  return {
    counts: {
      prs: u.pullRequests && u.pullRequests.totalCount,
      issues: u.issues && u.issues.totalCount,
      contribs: u.repositoriesContributedTo && u.repositoriesContributedTo.totalCount,
    },
  };
}

async function fetchCounts(token) {
  let last = "unknown";
  for (let i = 1; i <= TRIES; i++) {
    const r = await ask(token);
    if (r.counts) {
      for (const [k, v] of Object.entries(r.counts)) {
        if (!Number.isInteger(v) || v < 0) fail(`GitHub API gave a bad count for ${k}: ${JSON.stringify(v)}`);
      }
      return r.counts;
    }
    last = r.reason;
    if (i < TRIES) await sleep(RETRY_MS);
  }
  return fail(`${last} (gave up after ${TRIES} tries)`);
}

const SLOTS = [
  ["prs", "prs_merged", "merged PRs"],
  ["issues", "issues", "issues"],
  ["contribs", "contribs", "contributed across repos"],
];

/** The card text with the new numbers; the old numbers come back too. */
function rewrite(svg, counts) {
  let out = svg;
  const old = {};
  for (const [key, id] of SLOTS) {
    const re = new RegExp(`(data-testid="${id}"\\s*>\\s*)(\\d+)(\\s*<)`);
    const m = re.exec(out);
    if (!m) fail(`assets/stats.svg has no number slot data-testid="${id}"`);
    old[key] = Number(m[2]);
    out = out.replace(re, `$1${counts[key]}$3`);
  }
  const descRe = /(<desc id="descId">)[^<]*(<\/desc>)/;
  if (!descRe.test(out)) fail('assets/stats.svg has no <desc id="descId"> line');
  out = out.replace(descRe, `$1Total PRs Merged: ${counts.prs}, Total Issues: ${counts.issues}, Contributed across repos: ${counts.contribs}$2`);
  out = out.replace(/(<title id="titleId">)GitHub stats, Rank: [^<]*(<\/title>)/, "$1GitHub stats$2");
  return { text: out, old };
}

function writeAtomic(file, content) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

async function main(argv) {
  let dryRun = false;
  let svgPath = path.join("assets", "stats.svg");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") dryRun = true;
    else if (argv[i] === "--svg" && argv[i + 1]) svgPath = argv[++i];
    else fail(`unknown option ${argv[i]} (usage: stats-card.mjs [--dry-run] [--svg PATH])`);
  }
  const token = process.env.GITHUB_TOKEN;
  if (!token) fail("GITHUB_TOKEN is not set");
  let svg;
  try {
    svg = fs.readFileSync(svgPath, "utf8");
  } catch (err) {
    fail(`cannot read ${svgPath}: ${err.code || err.message}`);
  }
  const counts = await fetchCounts(token);
  const { text, old } = rewrite(svg, counts);
  // Only a change in the numbers counts; the title and desc are tidied when a write happens anyway.
  if (SLOTS.every(([key]) => old[key] === counts[key])) {
    console.log("stats: unchanged");
    return;
  }
  console.log(`stats: merged PRs ${old.prs} -> ${counts.prs}, issues ${old.issues} -> ${counts.issues}, contributed across repos ${old.contribs} -> ${counts.contribs}`);
  if (!dryRun) writeAtomic(svgPath, text);
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`stats: error: ${err.message}`);
  process.exitCode = 1;
});
