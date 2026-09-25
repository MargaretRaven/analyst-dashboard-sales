import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Loads `.env` for the LOCAL run, searching upwards from this file — never relative
// to the working directory. On the deployed server there is no `.env` (excluded from
// the archive) — the three managed variables arrive via the process environment, so
// this is a no-op there. Values already in `process.env` always win.
function loadEnvUpwards(startDir, maxLevels = 4) {
  let dir = path.resolve(startDir);
  for (let level = 0; level <= maxLevels; level += 1) {
    const file = path.join(dir, ".env");
    if (existsSync(file)) {
      try {
        for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
          const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
          if (!m || m[1] in process.env) continue;
          process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
        }
      } catch {
        // Unreadable file — treat as absent and look no further.
      }
      return file;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const KEY_FROM_ENVIRONMENT = typeof process.env.BITRIX_API_KEY === "string" && process.env.BITRIX_API_KEY !== "";
const ENV_FILE = loadEnvUpwards(__dirname);

const PORT = process.env.PORT || 3000;
const BASE = process.env.BITRIX_API_BASE_URL || "";
const KEY = process.env.BITRIX_API_KEY || "";
const PORTAL_DOMAIN = process.env.BITRIX_PORTAL_DOMAIN || "";
const PUBLIC_DIR = path.join(__dirname, "public");

// Generous — a loaded portal can answer after a minute or more.
const PORTAL_TIMEOUT_MS = Number(process.env.PORTAL_TIMEOUT_MS || 180_000);

console.log(
  KEY
    ? `portal key loaded from ${KEY_FROM_ENVIRONMENT ? "the environment" : ENV_FILE}`
    : `NO portal key: ${ENV_FILE ? `${ENV_FILE} has no BITRIX_API_KEY` : "no .env found and none in the environment"}` +
      " — /api/* will report the missing key until it appears",
);

class PortalError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.kind = kind;
    this.status = status ?? null;
  }
}

// Call the Vibe API (`/v1`). Identity model (reviewer requirement):
// - the app key always goes in `X-Api-Key`;
// - when a signed-in visitor is present, their session token travels in
//   `Authorization: Bearer <X-Vibe-Authorization>` so the platform applies the
//   EMPLOYEE's own rights instead of the app key's.
async function portal(pathname, { method = "GET", body, auth } = {}) {
  if (!KEY || !BASE) throw new PortalError("no_key", "portal env vars are absent");
  const headers = { "X-Api-Key": KEY, Accept: "application/json" };
  if (auth) headers.Authorization = `Bearer ${auth}`;
  if (body) headers["Content-Type"] = "application/json";

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  // Rate-limit retry (Section 5, principle 3): on 429 back off exponentially and
  // honor the platform's X-RateLimit-* / Retry-After hints rather than hammering.
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PORTAL_TIMEOUT_MS);
    const startedAt = Date.now();
    let res;
    try {
      res = await fetch(`${BASE}${pathname}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: ctl.signal,
      });
    } catch (err) {
      const kind = err?.name === "AbortError" ? "timeout" : "unreachable";
      if (attempt < MAX_ATTEMPTS) { await delay(500 * attempt); continue; }
      throw new PortalError(kind, `${pathname} ${kind} after ${Date.now() - startedAt}ms`);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }

    if (res.status === 429 && attempt < MAX_ATTEMPTS) {
      // Prefer an explicit Retry-After / rate-limit reset header, else exponential backoff.
      const retryAfter = Number(res.headers.get("retry-after")) || 0;
      const wait = retryAfter > 0 ? retryAfter * 1000 : Math.min(1000 * 2 ** (attempt - 1), 4000);
      await delay(wait);
      continue;
    }

    if (!res.ok) {
      const kind = res.status === 429 ? "rate_limited"
        : res.status === 401 || res.status === 403 ? "denied"
        : "portal_error";
      throw new PortalError(kind, data?.error?.message || `portal_error_${res.status}`, res.status);
    }
    return data?.data ?? data;
  }
  throw new PortalError("rate_limited", `${pathname} rate limited after ${MAX_ATTEMPTS} attempts`);
}

const HTTP_BY_KIND = {
  no_key: 503, timeout: 504, unreachable: 504,
  rate_limited: 429, denied: 403, portal_error: 502,
};
const TEXT_BY_KIND = {
  no_key: "Портал не подключён — приложение запущено без ключа доступа.",
  timeout: "Портал отвечает дольше обычного, данные ещё не обновились. Он под нагрузкой — попробуйте через несколько минут.",
  unreachable: "Не удалось связаться с порталом. Похоже на временный сбой сети.",
  rate_limited: "Слишком много запросов к порталу. Данные обновятся через несколько минут.",
  denied: "Ключ доступа отклонён порталом. Переподключите Битрикс24 в приложении.",
  portal_error: "Портал вернул ошибку при запросе данных.",
};

// ---- user-scoped data model --------------------------------------------------
// No shared deal snapshot. Each visitor is served data derived on request under
// their own session token, so the platform applies the employee's own rights.
// A small per-user cache keeps re-access fast, but nothing is shared across users
// and no full deal list is ever sent to the browser.

const NUMERIC_UID = /^[0-9]+$/;

function authFrom(req) {
  const h = req.headers["x-vibe-authorization"];
  if (typeof h === "string" && h) {
    // Normalize "vibe_session_..." / "Bearer vibe_session_..." to the raw token.
    return h.replace(/^Bearer\s+/i, "").trim();
  }
  return null;
}

function uidFrom(req) {
  const v = req.headers["x-vibe-user-id"];
  return typeof v === "string" && NUMERIC_UID.test(v) ? Number(v) : null;
}

// ---- deal dictionaries (small, non-user-scoped, refreshed rarely) ------------
let categoriesCache = { at: 0, items: [] };
let stagesCache = { at: 0, map: {}, items: [] };
let usersCache = { at: 0, map: {} };
const CACHE_TTL = 15 * 60_000;

async function fetchCategories() {
  if (categoriesCache.items.length && Date.now() - categoriesCache.at < CACHE_TTL) {
    return categoriesCache.items;
  }
  let items = [];
  for (const p of ["/deal-categories", "/deals/categories", "/crm/category/list"]) {
    try {
      const body = await portal(p);
      const arr = Array.isArray(body) ? body : (body?.items ?? body?.categories ?? body?.data ?? []);
      if (Array.isArray(arr)) {
        items = arr
          .map((c) => ({ id: c.id ?? c.categoryId ?? null, name: c.name ?? c.title ?? `Воронка ${c.id ?? "?"}` }))
          .filter((c) => c.id != null);
        if (items.length) break;
      }
    } catch { /* try next candidate */ }
  }
  categoriesCache = { at: Date.now(), items };
  return items;
}

async function fetchStageStatuses() {
  if (stagesCache.items.length && Date.now() - stagesCache.at < CACHE_TTL) {
    return stagesCache;
  }
  const items = [];
  let offset = 0;
  for (let guard = 0; guard < 100; guard += 1) {
    const body = await portal("/statuses/search", {
      method: "POST",
      body: { filter: {}, limit: 100, offset },
    });
    const page = Array.isArray(body) ? body : (body?.items ?? body?.data ?? []);
    if (!Array.isArray(page) || page.length === 0) break;
    for (const s of page) {
      if (typeof s.entityId === "string" && s.entityId.startsWith("DEAL_STAGE")) {
        items.push(s);
      }
    }
    offset += page.length;
    if (page.length < 100) break;
  }
  const map = {};
  for (const s of items) {
    if (s.statusId && s.name) {
      map[s.statusId] = { name: s.name, semantics: s.semantics || null, sort: typeof s.sort === "number" ? s.sort : 9999 };
    }
  }
  stagesCache = { at: Date.now(), map, items };
  return stagesCache;
}

async function fetchUsers() {
  if (Object.keys(usersCache.map).length && Date.now() - usersCache.at < CACHE_TTL) {
    return usersCache.map;
  }
  const map = {};
  let lastId = 0;
  let page;
  do {
    const body = await portal("/users/search", {
      method: "POST",
      body: { filter: { ">id": lastId }, select: ["id", "name", "lastName", "secondName"], order: { id: "ASC" }, limit: 100 },
    });
    page = Array.isArray(body) ? body : (body?.items ?? body?.data ?? []);
    if (!Array.isArray(page) || page.length === 0) break;
    for (const u of page) {
      if (typeof u.id === "undefined") continue;
      const parts = [u.lastName, u.name, u.secondName].filter(Boolean);
      map[String(u.id)] = parts.join(" ") || `#${u.id}`;
      if (Number(u.id) > lastId) lastId = Number(u.id);
    }
  } while (page && page.length >= 100);
  usersCache = { at: Date.now(), map };
  return map;
}

// ---- derived data for the dashboard (always under the visitor's token) --------

function periodFromMs(period) {
  const now = Date.now();
  if (period === "30") return now - 30 * 86400000;
  if (period === "90") return now - 90 * 86400000;
  if (period === "180") return now - 180 * 86400000;
  if (period === "year") { const d = new Date(); return new Date(d.getFullYear(), 0, 1).getTime(); }
  return null; // "all"
}

async function collectDashboard(auth, q) {
  const period = q.period || "all";
  const category = q.category; // "" or null => all funnels
  const stage = q.stage; // "" or null => all stages
  const scope = q.scope || "all"; // all | mine
  const meId = q.meId;

  const from = periodFromMs(period);
  const dateFilter = from ? { createdAt: { "$gte": new Date(from).toISOString() } } : {};
  const categoryFilter = category ? { categoryId: Number(category) } : {};
  const stageFilter = stage ? { stageId: stage } : {};
  const responsibleFilter = (scope === "mine" && meId) ? { assignedById: meId } : {};

  const baseFilter = { ...dateFilter, ...categoryFilter, ...stageFilter, ...responsibleFilter };

  // Funnel summary: aggregation platform-side, groupBy stageId (+ sum of amount).
  const funnelAgg = await portal("/deals/aggregate", {
    method: "POST",
    auth,
    body: {
      aggregate: [{ field: "amount", function: "sum" }],
      filter: baseFilter,
      groupBy: "stageId",
    },
  });

  // KPI. Open deals (in work) sum: no date window — the whole funnel now.
  const openFilter = { ...categoryFilter, ...stageFilter, ...responsibleFilter, ...(stage ? {} : { stageSemanticId: "P" }) };
  const openAgg = await portal("/deals/aggregate", {
    method: "POST",
    auth,
    body: { aggregate: [{ field: "amount", function: "sum" }], filter: openFilter },
  });

  // Won deals sum + count within the period.
  const wonFilter = { ...dateFilter, ...categoryFilter, ...stageFilter, ...responsibleFilter, stageSemanticId: "S" };
  const wonAgg = await portal("/deals/aggregate", {
    method: "POST",
    auth,
    body: { aggregate: [{ field: "amount", function: "sum" }], filter: wonFilter },
  });

  // Recent deals: separate narrow request.
  const recent = await portal("/deals/search", {
    method: "POST",
    auth,
    body: {
      filter: baseFilter,
      select: ["id", "title", "amount", "currency", "stageId", "assignedById", "createdAt", "categoryId"],
      sort: { createdAt: "desc" },
      limit: 15,
      withTotal: false,
    },
  });
  const recentList = Array.isArray(recent) ? recent : (recent?.items ?? recent?.data ?? []);

  const groups = (funnelAgg && Array.isArray(funnelAgg.groups)) ? funnelAgg.groups : [];
  const openSum = openAgg?.aggregates?.amount?.sum ?? 0;
  const openCount = openAgg?.count ?? 0;
  const wonSum = wonAgg?.aggregates?.amount?.sum ?? 0;
  const wonCount = wonAgg?.count ?? 0;
  const avg = wonCount ? Math.round(wonSum / wonCount) : 0;

  return {
    funnel: groups.map((g) => ({
      stageId: g.stageId,
      count: g.count ?? 0,
      sum: g.aggregates?.amount?.sum ?? 0,
      truncated: Boolean(g.truncated || funnelAgg?.meta?.truncated),
    })),
    kpi: { openSum, openCount, wonCount, wonSum, avg },
    recent: recentList.slice(0, 15).map((d) => ({
      id: d.id, title: d.title, amount: d.amount, currency: d.currency,
      stageId: d.stageId, assignedById: d.assignedById, createdAt: d.createdAt, categoryId: d.categoryId,
    })),
    truncated: Boolean(funnelAgg?.meta?.truncated) || Boolean(openAgg?.meta?.truncated) || Boolean(wonAgg?.meta?.truncated),
  };
}

// Per-user cache with bounded size to keep repeated access fast.
const userCache = new Map();
const USER_CACHE_TTL = 60_000;
const USER_CACHE_MAX = 50;

function remember(userId, key, value) {
  let entry = userCache.get(userId);
  if (!entry) { entry = new Map(); userCache.set(userId, entry); }
  entry.set(key, { at: Date.now(), value });
  if (userCache.size > USER_CACHE_MAX) {
    const oldest = userCache.keys().next().value;
    if (oldest !== undefined) userCache.delete(oldest);
  }
}

function recall(userId, key) {
  const entry = userCache.get(userId);
  const hit = entry && entry.get(key);
  if (hit && Date.now() - hit.at < USER_CACHE_TTL) return hit.value;
  return null;
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }

  if (url.pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      keyPresent: Boolean(KEY),
      keySource: KEY ? (KEY_FROM_ENVIRONMENT ? "environment" : ENV_FILE) : null,
      baseUrlPresent: Boolean(BASE),
      portalTimeoutMs: PORTAL_TIMEOUT_MS,
    }));
    return;
  }

  if (url.pathname === "/api/me") {
    // Proof of actual scopes / access mode, without the key itself.
    if (!KEY) { res.writeHead(503, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: TEXT_BY_KIND.no_key })); return; }
    try {
      const me = await portal("/me");
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({
        success: true,
        data: {
          type: me?.type ?? null,
          portal: me?.portal ?? null,
          scopes: me?.scopes ?? [],
          accessMode: me?.accessMode ?? null,
          currentUser: me?.currentUser ?? null,
        },
      }));
    } catch (err) {
      const kind = err.kind || "portal_error";
      res.writeHead(HTTP_BY_KIND[kind] || 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: TEXT_BY_KIND[kind], kind }));
    }
    return;
  }

  if (url.pathname === "/api/dashboard") {
    const auth = authFrom(req);
    const meId = uidFrom(req);
    if (!auth) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Сессия платформы не обнаружена. Войдите в Битрикс24." }));
      return;
    }

    const q = {
      period: url.searchParams.get("period") || "all",
      category: url.searchParams.get("category") || "",
      stage: url.searchParams.get("stage") || "",
      scope: url.searchParams.get("scope") || "all",
      meId,
    };
    const cacheKey = `${q.period}|${q.category}|${q.stage}|${q.scope}`;

    const meta = { portalDomain: PORTAL_DOMAIN, meId };
    let payload = null;
    let err = null;

    if (meId != null) payload = recall(meId, cacheKey);

    if (payload) {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ...payload, me: { id: meId }, meta }));
      return;
    }

    try {
      const [categories, stages, users, data] = await Promise.all([
        fetchCategories(),
        fetchStageStatuses(),
        fetchUsers(),
        collectDashboard(auth, q),
      ]);
      payload = { categories, stages: { map: stages.map, items: stages.items }, users, ...data };
      if (meId != null) remember(meId, cacheKey, payload);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ...payload, me: { id: meId }, meta }));
    } catch (e) {
      const kind = e.kind || "portal_error";
      res.writeHead(HTTP_BY_KIND[kind] || 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: TEXT_BY_KIND[kind], kind, meta }));
    }
    return;
  }

  // static — served only from PUBLIC_DIR, never from the session folder root
  const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const isDotfile = rel.split("/").some((seg) => seg.startsWith("."));
  const filePath = path.resolve(PUBLIC_DIR, rel);
  const insidePublic = filePath === PUBLIC_DIR || filePath.startsWith(PUBLIC_DIR + path.sep);
  if (isDotfile || !insidePublic) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const file = await readFile(filePath);
    const ext = path.extname(filePath);
    const type = ext === ".html" ? "text/html; charset=utf-8"
      : ext === ".js" ? "text/javascript; charset=utf-8"
      : ext === ".css" ? "text/css; charset=utf-8"
      : ext === ".svg" ? "image/svg+xml"
      : "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(file);
  } catch {
    res.writeHead(404).end("Not found");
  }
});

server.listen(PORT, () => console.log(`listening on ${PORT}`));

// Startup self-check: report the key's actual type / access mode / scopes to the
// runtime log (never the key itself). Lets us verify the identity model on the
// deployed app without exposing secrets. See safety rules, "GET /v1/me" principle.
(async () => {
  try {
    const me = await portal("/me");
    console.log(`[me] type=${me?.type ?? "?"} accessMode=${me?.accessMode ?? "?"}`);
    if (Array.isArray(me?.scopes)) {
      console.log(`[me] scopes=${me.scopes.join(",")}`);
    }
  } catch (e) {
    console.log(`[me] self-check failed: ${e?.kind || "error"}`);
  }
})();
