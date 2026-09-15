// @macotron needs 1.2

const opts = macotron.plugin({
  title: "Linear",
  description: "Search Linear issues from the launch bar.",
  help: "Create a personal API key in Linear under Settings → Security & access → Personal API keys, then paste it below. Type at least two characters in the launch bar to search your workspace; Enter opens the issue in your browser.",
  options: {
    apiKey: {
      type: "password",
      label: "Linear API key",
      required: true,
      placeholder: "lin_api_…",
      help: "Stored in the macOS Keychain, never in settings.json.",
    },
    limit: {
      type: "number",
      label: "Results",
      default: 8,
      min: 1,
      max: 25,
      step: 1,
      help: "How many issues to list in the launch bar.",
    },
  },
});

const ENDPOINT = "https://api.linear.app/graphql";
const MIN_QUERY = 2;
const DEBOUNCE_MS = 180;
const CACHE_MS = 15000;
const URL_CACHE_KEY = "linear.urls";
const URL_CACHE_MAX = 200;

// Variables rather than an interpolated term: a ticket search is user input and
// may hold quotes or backslashes that would otherwise break out of the query.
const SEARCH = "query Search($term: String!, $first: Int!) { searchIssues(term: $term, first: $first) { nodes { identifier title url state { name } assignee { name } } } }";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function apiKey() {
  return String(opts.apiKey || "").trim();
}

// Surfaces the last failure on the plugin in Settings. Empty list clears it.
function report(error) {
  if (!apiKey()) {
    macotron.checks([{ title: "API key", ok: false, message: "Add a Linear personal API key in Settings." }]);
  } else if (error) {
    macotron.checks([{ title: "Linear", ok: false, message: error }]);
  } else {
    macotron.checks([]);
  }
}

async function graphql(query, variables) {
  const key = apiKey();
  if (!key) return { error: "No API key set." };
  let res;
  try {
    res = await macotron.http.post(ENDPOINT, JSON.stringify({ query, variables }), {
      // A personal API key goes in Authorization raw, with no "Bearer " prefix.
      // OAuth access tokens are the ones that take Bearer.
      headers: { "Content-Type": "application/json", Authorization: key },
      timeout: 10000,
    });
  } catch (e) {
    return { error: String(e) };
  }
  // http.* never rejects on a network failure, it resolves with status 0.
  if (!res || res.status === 0) return { error: "Network error: " + ((res && res.body) || "no response") };
  if (res.status === 401 || res.status === 403) return { error: "Linear rejected the API key." };
  if (res.status === 429) return { error: "Rate limited by Linear. Try again shortly." };
  if (res.status !== 200) return { error: "Linear returned HTTP " + res.status };
  let json;
  try {
    json = JSON.parse(res.body);
  } catch (e) {
    return { error: "Linear sent malformed JSON." };
  }
  if (json.errors && json.errors.length) return { error: json.errors[0].message || "GraphQL error" };
  return { data: json.data };
}

// Row ids have to survive a plugin reload: the launcher drops the onClick
// closure when newer keystrokes replace the rows, and falls back to run(id).
function loadUrls() {
  try {
    return JSON.parse(localStorage.getItem(URL_CACHE_KEY) || "{}") || {};
  } catch (e) {
    return {};
  }
}

function rememberUrls(issues) {
  const map = loadUrls();
  for (const issue of issues) map[issue.identifier] = issue.url;
  const keys = Object.keys(map);
  // ponytail: insertion-order trim, good enough for a launcher cache. Swap for
  // a timestamped LRU if the cap ever starts evicting live rows.
  if (keys.length > URL_CACHE_MAX) {
    for (const k of keys.slice(0, keys.length - URL_CACHE_MAX)) delete map[k];
  }
  try {
    localStorage.setItem(URL_CACHE_KEY, JSON.stringify(map));
  } catch (e) {
    // A full store must not break search.
  }
}

const recent = new Map();
let latest = 0;

async function search(term) {
  const hit = recent.get(term);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  const first = Math.min(25, Math.max(1, Number(opts.limit) || 8));
  const out = await graphql(SEARCH, { term, first });
  const result = out.error
    ? { at: Date.now(), error: out.error, issues: [] }
    : { at: Date.now(), issues: (out.data && out.data.searchIssues && out.data.searchIssues.nodes) || [] };
  recent.set(term, result);
  if (recent.size > 40) recent.delete(recent.keys().next().value);
  return result;
}

function row(issue) {
  const state = (issue.state && issue.state.name) || "";
  const who = (issue.assignee && issue.assignee.name) || "Unassigned";
  return {
    id: issue.identifier,
    title: issue.identifier + " " + issue.title,
    subtitle: state ? state + " · " + who : who,
    sfSymbol: "checklist",
    kind: "Linear",
    onClick: () => macotron.url.open(issue.url),
  };
}

async function openById(id) {
  const cached = loadUrls()[id];
  if (cached) {
    macotron.url.open(cached);
    return;
  }
  const res = await search(id);
  const hit = (res.issues || []).find((issue) => issue.identifier === id);
  if (hit) macotron.url.open(hit.url);
  else console.warn("linear: no issue found for " + id);
}

macotron.launcher.query(
  "linear",
  async (query) => {
    const term = String(query || "").trim();
    if (term.length < MIN_QUERY) return [];
    // The handler fires per keystroke, so settle briefly and bail if a newer
    // one arrived. The launcher discards stale answers on its own.
    const mine = ++latest;
    await sleep(DEBOUNCE_MS);
    if (mine !== latest) return [];
    const res = await search(term);
    if (mine !== latest) return [];
    if (res.error) {
      report(res.error);
      return [];
    }
    report(null);
    rememberUrls(res.issues);
    return res.issues.map(row);
  },
  { secondary: true, run: openById }
);

report(null);
