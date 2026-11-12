"use strict";
// Tests for .github/scripts/stats-card.mjs and .github/workflows/stats-card.yml.
// The GraphQL API is a local http server (GITHUB_GRAPHQL_URL); the card is a temp copy of
// assets/stats.svg. Nothing here touches the network or the real card.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SCRIPT = path.join(__dirname, "stats-card.mjs");
const REAL_SVG = path.join(__dirname, "..", "..", "assets", "stats.svg");
const WORKFLOW = path.join(__dirname, "..", "workflows", "stats-card.yml");

const OLD = { prs: 186, issues: 138, contribs: 35 };
const NEW = { prs: 200, issues: 150, contribs: 40 };
const reply = (c) => ({ data: { user: { pullRequests: { totalCount: c.prs }, issues: { totalCount: c.issues }, repositoriesContributedTo: { totalCount: c.contribs } } } });

function card(t, edit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stats-card-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "stats.svg");
  let text = fs.readFileSync(REAL_SVG, "utf8");
  if (edit) text = edit(text);
  fs.writeFileSync(file, text);
  const old = new Date("2001-02-03T04:05:06Z");
  fs.utimesSync(file, old, old);
  return { file, bytes: fs.readFileSync(file), mtimeMs: fs.statSync(file).mtimeMs };
}

/** handler(request number, body, res). Returns { url, requests }. */
function api(t, handler) {
  const seen = { requests: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.requests.push({ method: req.method, headers: req.headers, body });
      handler(seen.requests.length, body, res, req);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }));
      seen.url = `http://127.0.0.1:${server.address().port}/graphql`;
      resolve(seen);
    });
  });
}

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

function run(url, svg, args = [], env = {}) {
  const base = { ...process.env };
  for (const k of ["NODE_TEST_CONTEXT", "NODE_OPTIONS", "GITHUB_TOKEN", "GITHUB_GRAPHQL_URL", "STATS_USER", "STATS_TIMEOUT_MS", "STATS_RETRY_MS"]) delete base[k];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, "--svg", svg, ...args], {
      env: { ...base, GITHUB_TOKEN: "test-token", GITHUB_GRAPHQL_URL: url, STATS_TIMEOUT_MS: "200", STATS_RETRY_MS: "20", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => child.kill(), 30000);
    const started = Date.now();
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, ms: Date.now() - started });
    });
  });
}

const untouched = (c) => {
  assert.ok(fs.readFileSync(c.file).equals(c.bytes), "stats.svg content changed");
  assert.equal(fs.statSync(c.file).mtimeMs, c.mtimeMs, "stats.svg was written");
};
const slot = (svg, id) => {
  const m = new RegExp(`data-testid="${id}"\\s*>\\s*(\\d+)\\s*<`).exec(svg);
  return m ? Number(m[1]) : null;
};
/** The card with the three numbers, the desc line and the title blanked: what must stay as it was. */
const frame = (svg) =>
  svg
    .replace(/(data-testid="(?:prs_merged|issues|contribs)"\s*>\s*)\d+(\s*<)/g, "$1#$2")
    .replace(/(<desc[^>]*>)[^<]*(<\/desc>)/, "$1#$2")
    .replace(/(<title[^>]*>)[^<]*(<\/title>)/, "$1#$2");

// ---------------------------------------------------------------------------------- J4-1, J4-2

test("@J4-1 the three numbers, the desc line and the title are rewritten and old and new values are printed", async (t) => {
  const c = card(t);
  const srv = await api(t, (n, body, res) => json(res, 200, reply(NEW)));
  const r = await run(srv.url, c.file);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), "stats: merged PRs 186 -> 200, issues 138 -> 150, contributed across repos 35 -> 40");
  const svg = fs.readFileSync(c.file, "utf8");
  assert.equal(slot(svg, "prs_merged"), NEW.prs);
  assert.equal(slot(svg, "issues"), NEW.issues);
  assert.equal(slot(svg, "contribs"), NEW.contribs);
  assert.match(svg, /<desc[^>]*>Total PRs Merged: 200, Total Issues: 150, Contributed across repos: 40<\/desc>/);
  assert.match(svg, /<title[^>]*>GitHub stats<\/title>/);
  assert.doesNotMatch(svg, /Rank/);
  assert.equal(frame(svg), frame(c.bytes.toString("utf8")), "something other than the three numbers, desc and title changed");
});

test("@J4-1 the request carries the token, the user and the three counts asked for", async (t) => {
  const c = card(t);
  const srv = await api(t, (n, body, res) => json(res, 200, reply(NEW)));
  const r = await run(srv.url, c.file);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(srv.requests.length, 1);
  const q = srv.requests[0];
  assert.equal(q.method, "POST");
  assert.ok(String(q.headers.authorization || "").includes("test-token"), "the token is sent in the authorization header");
  assert.match(q.body, /shrinivas-sn/);
  assert.match(q.body, /MERGED/);
  assert.match(q.body, /repositoriesContributedTo/);
  assert.match(q.body, /issues/);
  assert.ok(!r.stdout.includes("test-token") && !r.stderr.includes("test-token"), "the token is never printed");
});

test("@J4-1 STATS_USER chooses the user that is asked for", async (t) => {
  const c = card(t);
  const srv = await api(t, (n, body, res) => json(res, 200, reply(NEW)));
  const r = await run(srv.url, c.file, [], { STATS_USER: "someone-else-1" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(srv.requests[0].body, /someone-else-1/);
  assert.doesNotMatch(srv.requests[0].body, /shrinivas-sn/);
});

test("@J4-1 a dry run prints old and new values and writes nothing", async (t) => {
  const c = card(t);
  const srv = await api(t, (n, body, res) => json(res, 200, reply(NEW)));
  const r = await run(srv.url, c.file, ["--dry-run"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), "stats: merged PRs 186 -> 200, issues 138 -> 150, contributed across repos 35 -> 40");
  untouched(c);
});

test("@J4-2 unchanged counts print unchanged and write nothing", async (t) => {
  const c = card(t);
  const srv = await api(t, (n, body, res) => json(res, 200, reply(OLD)));
  const r = await run(srv.url, c.file);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), "stats: unchanged");
  untouched(c);
});

test("@J4-2 a second run after a rewrite is unchanged and the card is byte for byte the same", async (t) => {
  const c = card(t);
  const srv = await api(t, (n, body, res) => json(res, 200, reply(NEW)));
  const first = await run(srv.url, c.file);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const after = fs.readFileSync(c.file);
  const old = new Date("2002-02-03T04:05:06Z");
  fs.utimesSync(c.file, old, old);
  const second = await run(srv.url, c.file);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(second.stdout.trim(), "stats: unchanged");
  assert.ok(fs.readFileSync(c.file).equals(after));
  assert.equal(fs.statSync(c.file).mtimeMs, old.getTime());
});

// ------------------------------------------------------------------------------------- J4-F1

test("@J4-F1 a 401 answer fails at once with the reason on stderr and the card unchanged", async (t) => {
  const c = card(t);
  const srv = await api(t, (n, body, res) => json(res, 401, { message: "Bad credentials-xyz" }));
  const r = await run(srv.url, c.file);
  assert.equal(r.signal, null);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /401/);
  assert.equal(srv.requests.length, 1, "a 4xx must not be retried");
  untouched(c);
});

test("@J4-F1 a 403 and a 404 answer both fail without a retry", async (t) => {
  for (const status of [403, 404]) {
    const c = card(t);
    const srv = await api(t, (n, body, res) => json(res, status, { message: "nope" }));
    const r = await run(srv.url, c.file);
    assert.notEqual(r.status, 0, `status ${status}`);
    assert.match(r.stderr, new RegExp(String(status)));
    assert.equal(srv.requests.length, 1, `status ${status} was retried`);
    untouched(c);
  }
});

test("@J4-F1 an unreachable API fails with a reason and the card unchanged", async (t) => {
  const c = card(t);
  const srv = await api(t, (n, body, res) => json(res, 200, reply(NEW)));
  const dead = srv.url.replace(/:\d+\//, ":1/"); // nothing listens on port 1
  const r = await run(dead, c.file);
  assert.notEqual(r.status, 0);
  assert.notEqual(r.stderr.trim(), "");
  untouched(c);
});

test("@J4-F1 a missing token fails with a reason naming GITHUB_TOKEN", async (t) => {
  const c = card(t);
  const srv = await api(t, (n, body, res) => json(res, 200, reply(NEW)));
  const r = await run(srv.url, c.file, [], { GITHUB_TOKEN: "" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /GITHUB_TOKEN/);
  untouched(c);
});

// ------------------------------------------------------------------------------------- J4-F2

const bad = (c) => ({ data: { user: { ...reply(OLD).data.user, ...c } } });
const BAD_REPLIES = {
  "user is null": { data: { user: null } },
  "data is null": { data: null },
  "empty object": {},
  "issues missing": { data: { user: { pullRequests: { totalCount: 1 }, repositoriesContributedTo: { totalCount: 1 } } } },
  "repositoriesContributedTo missing": { data: { user: { pullRequests: { totalCount: 1 }, issues: { totalCount: 1 } } } },
  "negative count": bad({ issues: { totalCount: -1 } }),
  "fractional count": bad({ pullRequests: { totalCount: 1.5 } }),
  "string count": bad({ repositoriesContributedTo: { totalCount: "12" } }),
  "null count": bad({ issues: { totalCount: null } }),
  "boolean count": bad({ pullRequests: { totalCount: true } }),
  "totalCount missing": bad({ issues: {} }),
  "errors list next to valid data": { errors: [{ message: "rate limited-abc" }], data: reply(NEW).data },
  "errors list alone": { errors: [{ message: "Could not resolve to a User-abc" }] },
};

test("@J4-F2 incomplete replies, error lists and bad counts all fail with the card unchanged", async (t) => {
  for (const [label, body] of Object.entries(BAD_REPLIES)) {
    const c = card(t);
    const srv = await api(t, (n, b, res) => json(res, 200, body));
    const r = await run(srv.url, c.file);
    assert.equal(r.signal, null, label);
    assert.notEqual(r.status, 0, `${label}: should exit non-zero\n${r.stdout}`);
    assert.notEqual(r.stderr.trim(), "", `${label}: needs a reason on stderr`);
    assert.equal(srv.requests.length, 1, `${label}: a bad answer is not retried`);
    untouched(c);
  }
});

test("@J4-F2 a reply that is not JSON fails with the card unchanged", async (t) => {
  const c = card(t);
  const srv = await api(t, (n, b, res) => json(res, 200, "<html>not json</html>"));
  const r = await run(srv.url, c.file);
  assert.notEqual(r.status, 0);
  assert.notEqual(r.stderr.trim(), "");
  untouched(c);
});

test("@J4-F2 the reason of an errors list is shown on stderr", async (t) => {
  const c = card(t);
  const srv = await api(t, (n, b, res) => json(res, 200, BAD_REPLIES["errors list alone"]));
  const r = await run(srv.url, c.file);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Could not resolve to a User-abc/);
});

test("@J4-F2 zero is a valid count", async (t) => {
  const c = card(t);
  const srv = await api(t, (n, b, res) => json(res, 200, reply({ prs: 0, issues: 0, contribs: 0 })));
  const r = await run(srv.url, c.file);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(slot(fs.readFileSync(c.file, "utf8"), "issues"), 0);
});

// ------------------------------------------------------------------------------------- J4-F3

test("@J4-F3 an API that hangs is timed out on each try, tried three times, then fails with the card unchanged", async (t) => {
  const c = card(t);
  const srv = await api(t, () => {}); // never answers
  const r = await run(srv.url, c.file);
  assert.equal(r.signal, null, "the script must finish by itself");
  assert.notEqual(r.status, 0);
  assert.equal(srv.requests.length, 3, "exactly three tries");
  assert.match(r.stderr, /time|abort/i);
  assert.ok(r.ms < 10000, `took ${r.ms} ms`);
  untouched(c);
});

test("@J4-F3 a 503 is retried up to three times, then fails naming the status", async (t) => {
  const c = card(t);
  const srv = await api(t, (n, b, res) => json(res, 503, { message: "DEPLOYMENT_PAUSED" }));
  const r = await run(srv.url, c.file);
  assert.notEqual(r.status, 0);
  assert.equal(srv.requests.length, 3);
  assert.match(r.stderr, /503/);
  untouched(c);
});

test("@J4-F3 two failures then a good answer still succeeds and rewrites the card", async (t) => {
  const c = card(t);
  const srv = await api(t, (n, b, res) => (n < 3 ? json(res, 502, { message: "bad gateway" }) : json(res, 200, reply(NEW))));
  const r = await run(srv.url, c.file);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(srv.requests.length, 3);
  assert.equal(slot(fs.readFileSync(c.file, "utf8"), "prs_merged"), NEW.prs);
});

test("@J4-F3 a hang then a good answer succeeds on the second try", async (t) => {
  const c = card(t);
  const srv = await api(t, (n, b, res) => { if (n >= 2) json(res, 200, reply(NEW)); });
  const r = await run(srv.url, c.file);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(srv.requests.length, 2);
});

test("@J4-F3 the pause between tries is STATS_RETRY_MS", async (t) => {
  const c = card(t);
  const srv = await api(t, (n, b, res) => json(res, 500, { message: "x" }));
  const r = await run(srv.url, c.file, [], { STATS_RETRY_MS: "400" });
  assert.notEqual(r.status, 0);
  assert.equal(srv.requests.length, 3);
  assert.ok(r.ms >= 700, `two pauses of 400 ms expected, whole run took ${r.ms} ms`);
});

// ------------------------------------------------------------------------------------- J4-F4

const SLOTS = {
  prs_merged: (s) => s.replace('data-testid="prs_merged"', 'data-testid="prs-merged-renamed"'),
  issues: (s) => s.replace('data-testid="issues"', 'data-testid="issues-renamed"'),
  contribs: (s) => s.replace('data-testid="contribs"', 'data-testid="contribs-renamed"'),
  desc: (s) => s.replace(/<desc[^>]*>[^<]*<\/desc>/, ""),
};

for (const [name, edit] of Object.entries(SLOTS)) {
  test(`@J4-F4 a card without the ${name} slot fails naming it and is left as it was`, async (t) => {
    const c = card(t, edit);
    assert.notEqual(c.bytes.toString("utf8"), fs.readFileSync(REAL_SVG, "utf8"), "fixture edit did not apply");
    const srv = await api(t, (n, b, res) => json(res, 200, reply(NEW)));
    const r = await run(srv.url, c.file);
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stderr, new RegExp(name));
    untouched(c);
  });
}

test("@J4-F4 an unreadable or missing card fails with a reason", async (t) => {
  const srv = await api(t, (n, b, res) => json(res, 200, reply(NEW)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stats-card-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = await run(srv.url, path.join(dir, "absent.svg"));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /absent\.svg/);
});

// -------------------------------------------------------------------------------------- J4-3

function workflowLines() {
  const text = fs.readFileSync(WORKFLOW, "utf8").replace(/\r\n/g, "\n");
  return text.split("\n").filter((l) => !/^\s*#/.test(l));
}
const indentOf = (l) => l.match(/^ */)[0].length;
/** The lines nested under line `i` (more indented than it). */
function nested(lines, i) {
  const out = [];
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].trim() === "") continue;
    if (indentOf(lines[j]) <= indentOf(lines[i])) break;
    out.push(lines[j]);
  }
  return out;
}

test("@J4-3 the workflow no longer calls github-readme-stats.vercel.app", () => {
  const text = workflowLines().join("\n");
  assert.doesNotMatch(text, /vercel/i);
  assert.match(text, /stats-card\.mjs/, "the workflow runs the new script");
});

test("@J4-3 the workflow runs on a schedule and by hand", () => {
  const text = workflowLines().join("\n");
  assert.match(text, /^\s*schedule:/m);
  assert.match(text, /^\s*workflow_dispatch:/m);
});

test("@J4-3 every permissions block holds contents write and nothing else", () => {
  const lines = workflowLines();
  const blocks = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^\s*permissions:/.test(l));
  assert.ok(blocks.length >= 1, "no permissions: block");
  for (const { l, i } of blocks) {
    const inline = l.replace(/^\s*permissions:\s*/, "").trim();
    const entries = inline ? inline.replace(/[{}]/g, "").split(",").map((s) => s.trim()).filter(Boolean) : nested(lines, i).map((s) => s.trim());
    assert.deepEqual(entries, ["contents: write"], `permissions block at line ${i + 1}`);
  }
});

test("@J4-3 the workflow has a concurrency group", () => {
  const lines = workflowLines();
  const i = lines.findIndex((l) => /^\s*concurrency:/.test(l));
  assert.ok(i >= 0, "no concurrency: key");
  const inline = lines[i].replace(/^\s*concurrency:\s*/, "").trim();
  assert.ok(inline !== "" || nested(lines, i).some((l) => /^\s*group:\s*\S+/.test(l)), "concurrency has no group");
});

test("@J4-3 GITHUB_TOKEN is passed only in the env of the stats step", () => {
  const lines = workflowLines();
  const hits = lines.map((l, i) => ({ l, i })).filter(({ l }) => /GITHUB_TOKEN|github\.token/.test(l));
  assert.ok(hits.length >= 1, "the stats step gets no token");
  const stepStart = (i) => {
    // the nearest line above i that starts a list item at the steps indent
    for (let j = i; j >= 0; j--) if (/^\s*- /.test(lines[j]) && indentOf(lines[j]) <= indentOf(lines[i]) - 2) return j;
    return -1;
  };
  for (const { l, i } of hits) {
    const s = stepStart(i);
    assert.ok(s >= 0, `GITHUB_TOKEN outside any step (line ${i + 1}): ${l.trim()}`);
    let e = s + 1;
    while (e < lines.length && !(/^\s*- /.test(lines[e]) && indentOf(lines[e]) === indentOf(lines[s]) ) && (lines[e].trim() === "" || indentOf(lines[e]) > indentOf(lines[s]) )) e++;
    const step = lines.slice(s, e);
    assert.ok(step.some((x) => /stats-card\.mjs/.test(x)), `GITHUB_TOKEN used in a step that does not run the stats script (line ${i + 1}): ${l.trim()}`);
    const envAt = step.findIndex((x) => /^\s*(- )?env:\s*$/.test(x));
    assert.ok(envAt >= 0, "the stats step has no env: block");
    assert.ok(nested(step, envAt).some((x) => x === l), `GITHUB_TOKEN is not inside the stats step env (line ${i + 1}): ${l.trim()}`);
  }
});

test("@J4-3 no run line holds a GitHub expression", () => {
  const lines = workflowLines();
  let runLines = 0;
  lines.forEach((l, i) => {
    const m = /^(\s*)(- )?run:\s*(.*)$/.exec(l);
    if (!m) return;
    runLines++;
    const body = /^[|>]/.test(m[3].trim()) ? nested(lines, i) : [m[3]];
    for (const b of body) assert.ok(!b.includes("${{"), `expression inside a run: line ${i + 1}: ${b.trim()}`);
  });
  assert.ok(runLines >= 1, "no run: lines found");
});

test("@J4-3 the workflow rebases before it pushes", () => {
  const text = workflowLines().join("\n");
  const push = text.indexOf("git push");
  const pull = text.indexOf("git pull --rebase");
  assert.ok(push >= 0, "no git push");
  assert.ok(pull >= 0, "no git pull --rebase");
  assert.ok(pull < push, "git pull --rebase must come before git push");
  assert.equal(text.lastIndexOf("git push") > text.lastIndexOf("git pull --rebase"), true);
});
