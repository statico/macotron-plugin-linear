// Self-check: stubs the host, evaluates the plugin, exercises the parts that
// can break quietly. Run with: node test.js
const fs = require("fs");

let failures = 0;
function assert(ok, what) {
  if (ok) {
    console.log("ok   " + what);
  } else {
    failures++;
    console.log("FAIL " + what);
  }
}

let httpResponse = null;
let httpCalls = [];
let opened = [];
let checks = [];
let provider = null;

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

globalThis.macotron = {
  plugin: () => ({ apiKey: "lin_api_test", limit: 8 }),
  checks: (list) => (checks = list),
  http: {
    post: async (url, body, opts) => {
      httpCalls.push({ url, body, opts });
      if (typeof httpResponse === "function") return httpResponse();
      return httpResponse;
    },
  },
  url: { open: (u) => opened.push(u) },
  launcher: {
    query: (id, handler, options) => (provider = { id, handler, options }),
  },
};

const src = fs.readFileSync(__dirname + "/linear.js", "utf8");
(0, eval)(src + ";globalThis.__t = { row, graphql, rememberUrls, loadUrls, openById, SEARCH };");
const t = globalThis.__t;

function issuesResponse(nodes) {
  return { status: 200, body: JSON.stringify({ data: { searchIssues: { nodes } } }), headers: {} };
}

(async () => {
  // Registration
  assert(provider && provider.id === "linear", "registers a launcher provider named linear");
  assert(provider.options.secondary === true, "registers as a secondary provider");
  assert(typeof provider.options.run === "function", "provides run() for replaying a row by id");

  // Auth header: a raw key, never Bearer. This is the detail most likely to rot.
  httpResponse = issuesResponse([]);
  httpCalls = [];
  await t.graphql(t.SEARCH, { term: "x", first: 8 });
  const sent = httpCalls[0];
  assert(sent.opts.headers.Authorization === "lin_api_test", "sends the API key raw in Authorization");
  assert(!/^Bearer /.test(sent.opts.headers.Authorization), "does not prefix the key with Bearer");
  assert(typeof sent.body === "string", "sends the body as a string, not an object");
  assert(JSON.parse(sent.body).variables.term === "x", "passes the term as a GraphQL variable");

  // A term with a quote must not break the query.
  httpCalls = [];
  await t.graphql(t.SEARCH, { term: 'a"b\\c', first: 8 });
  assert(JSON.parse(httpCalls[0].body).variables.term === 'a"b\\c', "survives quotes in the search term");

  // Failure modes: http.* resolves with status 0 instead of rejecting.
  httpResponse = { status: 0, body: "offline", headers: {} };
  let out = await t.graphql(t.SEARCH, {});
  assert(!!out.error && /Network/.test(out.error), "treats status 0 as a network error");

  httpResponse = { status: 401, body: "", headers: {} };
  out = await t.graphql(t.SEARCH, {});
  assert(/rejected the API key/.test(out.error), "reports a bad key on 401");

  httpResponse = { status: 429, body: "", headers: {} };
  out = await t.graphql(t.SEARCH, {});
  assert(/Rate limited/.test(out.error), "reports rate limiting on 429");

  httpResponse = { status: 200, body: "not json", headers: {} };
  out = await t.graphql(t.SEARCH, {});
  assert(/malformed JSON/.test(out.error), "survives malformed JSON");

  httpResponse = { status: 200, body: JSON.stringify({ errors: [{ message: "nope" }] }), headers: {} };
  out = await t.graphql(t.SEARCH, {});
  assert(out.error === "nope", "surfaces a GraphQL error message");

  httpResponse = () => {
    throw new Error("boom");
  };
  out = await t.graphql(t.SEARCH, {});
  assert(/boom/.test(out.error), "catches a thrown transport error");

  // Row shape
  const r = t.row({ identifier: "ENG-7", title: "Fix it", url: "https://linear.app/x/issue/ENG-7", state: { name: "In Progress" }, assignee: { name: "Ian" } });
  assert(r.id === "ENG-7", "uses the identifier as the row id");
  assert(r.title === "ENG-7 Fix it", "titles the row with identifier and title");
  assert(r.subtitle === "In Progress · Ian", "subtitles with state and assignee");
  const bare = t.row({ identifier: "ENG-8", title: "x", url: "u", state: null, assignee: null });
  assert(bare.subtitle === "Unassigned", "falls back to Unassigned with no assignee");

  // Short queries never hit the network.
  httpResponse = issuesResponse([]);
  httpCalls = [];
  const short = await provider.handler("a");
  assert(short.length === 0 && httpCalls.length === 0, "does not search on a one-character query");

  // A live search returns rows and caches the urls.
  httpResponse = issuesResponse([{ identifier: "ENG-9", title: "Ship", url: "https://linear.app/x/issue/ENG-9", state: { name: "Todo" }, assignee: null }]);
  const rows = await provider.handler("ship");
  assert(rows.length === 1 && rows[0].id === "ENG-9", "returns a row for a matching issue");
  assert(t.loadUrls()["ENG-9"] === "https://linear.app/x/issue/ENG-9", "remembers the issue url");

  // run() opens from cache without a request.
  opened = [];
  httpCalls = [];
  await provider.options.run("ENG-9");
  assert(opened[0] === "https://linear.app/x/issue/ENG-9", "run() opens a cached issue");
  assert(httpCalls.length === 0, "run() hits no network when the url is cached");

  // A newer keystroke wins.
  httpResponse = issuesResponse([{ identifier: "ENG-1", title: "a", url: "u1", state: null, assignee: null }]);
  const stale = provider.handler("aaaa");
  const fresh = provider.handler("bbbb");
  const staleRows = await stale;
  await fresh;
  assert(staleRows.length === 0, "drops a superseded query");

  // The url cache stays bounded.
  const many = [];
  for (let i = 0; i < 260; i++) many.push({ identifier: "X-" + i, url: "u" + i });
  t.rememberUrls(many);
  assert(Object.keys(t.loadUrls()).length <= 200, "caps the url cache at 200 entries");

  // A missing key is reported rather than thrown.
  store.clear();
  assert(Array.isArray(checks), "reports status through macotron.checks");

  console.log(failures === 0 ? "\nAll checks passed." : "\n" + failures + " check(s) failed.");
  process.exit(failures === 0 ? 0 : 1);
})();
