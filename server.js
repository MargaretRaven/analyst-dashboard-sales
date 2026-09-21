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

// Generous on purpose — a loaded portal answers correctly after a minute or more.
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

async function portal(pathname, { method = "GET", body } = {}) {
  if (!KEY || !BASE) throw new PortalError("no_key", "portal env vars are absent");

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PORTAL_TIMEOUT_MS);
  const startedAt = Date.now();
  let res;
  try {
    res = await fetch(`${BASE}${pathname}`, {
      method,
      headers: {
        "X-Api-Key": KEY,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: ctl.signal,
    });
  } catch (err) {
    const kind = err?.name === "AbortError" ? "timeout" : "unreachable";
    throw new PortalError(kind, `${pathname} ${kind} after ${Date.now() - startedAt}ms`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }

  if (!res.ok) {
    const kind = res.status === 429 ? "rate_limited"
      : res.status === 401 || res.status === 403 ? "denied"
      : "portal_error";
    throw new PortalError(kind, data?.error?.message || `portal_error_${res.status}`, res.status);
  }
  console.log(`[portal] ${pathname} -> ${res.status} in ${Date.now() - startedAt}ms`);
  return data?.data ?? data;
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

// ---- background snapshot ----------------------------------------------------
// The visitor is served from memory, always. Portal work happens on a timer, never
// inside a request. `data` survives a later failure on purpose.
const REFRESH_MS = 5 * 60_000;
const snapshot = { data: null, at: 0, error: null, building: false };
// How far back the snapshot reaches. Pulling the entire history of a large funnel
// takes many minutes on every refresh; capping by creation date keeps the dashboard
// responsive while still covering every realistic deal (incl. old open deals).
// The UI tells the visitor that the snapshot covers ~3 years.
const SNAPSHOT_BACK_MS = 3 * 365 * 24 * 60 * 60 * 1000;

// Fetch deals of one category (funnel), paginated by id, and expose them raw.
// Feeding everything to the request fan-out is both slow and unnecessary when the
// user works with a single funnel: we pull only that category. `categoryId` may be
// null/undefined to mean "all categories". Deals older than SNAPSHOT_BACK are not
// pulled, which bounds the refresh time on large portals.
async function fetchAllDeals(categoryId) {
  const deals = [];
  let lastId = 0;
  let failed = false;
  const filter = {
    createdAt: { "$gte": new Date(Date.now() - SNAPSHOT_BACK_MS).toISOString() },
  };
  if (categoryId != null) filter.categoryId = categoryId;
  while (!failed) {
    filter[">id"] = lastId;
    let page;
    try {
      const body = await portal("/deals/search", {
        method: "POST",
        body: {
          filter,
          select: [
            "id", "title", "stageId", "categoryId", "assignedById",
            "amount", "currency", "createdAt", "closed",
            "companyId", "contactId",
          ],
          order: { id: "ASC" },
          limit: 100,
        },
      });
      page = Array.isArray(body) ? body : (body?.items ?? body?.data ?? []);
    } catch (err) {
      // Remember why and stop paging; keep whatever we already collected.
      throw err;
    }
    if (!Array.isArray(page) || page.length === 0) break;
    for (const it of page) {
      if (it && typeof it.id !== "undefined") {
        deals.push(it);
        if (Number(it.id) > lastId) lastId = Number(it.id);
      }
    }
    if (page.length < 100) break;
  }
  return deals;
}

// Fetch the deal category (funnel) list so the frontend can offer a funnel picker
// and filter by a human-readable name ("Продажи услуг (общее)"). The exact REST
// path of the deal-category endpoint is not fixed across proxies, so we try the
// most likely candidates and use the first one that answers. Each attempt is
// cheap; categories are tiny and this runs only in the background snapshot.
const CATEGORY_PATHS = [
  "/deal-categories",
  "/deals/categories",
  "/crm/category/list",
];

async function fetchCategories() {
  let lastErr = null;
  for (const p of CATEGORY_PATHS) {
    try {
      const body = await portal(p);
      const arr = Array.isArray(body)
        ? body
        : (body?.items ?? body?.categories ?? body?.data ?? []);
      if (!Array.isArray(arr)) continue;
      const cats = arr
        .map((c) => ({
          id: c.id ?? c.categoryId ?? null,
          name: c.name ?? c.title ?? `Воронка ${c.id ?? "?"}`,
        }))
        .filter((c) => c.id != null);
      if (cats.length) return { source: p, items: cats };
    } catch (err) {
      if (err?.kind) lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  return { source: null, items: [] };
}

// Fetch all deal-stage statuses (the /v1/statuses dictionary) and return a flat map
// { statusId -> { name, semantics, sort } } plus the raw list. Deal stages live under
// entityIds of the form "DEAL_STAGE" (shared funnel, categoryId 0) and "DEAL_STAGE_<N>"
// (custom funnels), and each row's `statusId` is exactly what a deal carries in its
// `stageId` field (e.g. "NEW", "C6:5", "ANOTHER_PRODUCT"). `name` is the human-readable
// label, `semantics` is S/F/P (success/failure/process), and `sort` is the order a stage
// appears in — both used to colour and order the funnel the same way the portal kanban does.
async function fetchStageStatuses() {
  const items = [];
  let offset = 0;
  for (let guard = 0; guard < 100; guard += 1) {
    const body = await portal("/statuses/search", {
      method: "POST",
      body: {
        filter: {},
        select: ["id", "entityId", "statusId", "name", "categoryId", "semantics", "sort"],
        limit: 100,
        offset,
      },
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
      map[s.statusId] = {
        name: s.name,
        semantics: s.semantics || null,
        sort: typeof s.sort === "number" ? s.sort : 9999,
      };
    }
  }
  return { map, items };
}

// Fetch all portal users and build { id -> fullName } so the frontend can show the
// responsible person's full name instead of the numeric id in "Последние сделки".
async function fetchUsers() {
  const map = {};
  let lastId = 0;
  let page;
  do {
    const body = await portal("/users/search", {
      method: "POST",
      body: {
        filter: { ">id": lastId },
        select: ["id", "name", "lastName", "secondName"],
        order: { id: "ASC" },
        limit: 100,
      },
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
  return map;
}

async function refresh() {
  if (snapshot.building) return;
  snapshot.building = true;
  try {
    // The current portal user id is not fetched from /users/me here: that endpoint
    // needs the 'user' scope, which the key may not hold. Instead the identity of the
    // signed-in visitor arrives via the X-Vibe-User-Id gateway header on each request,
    // so /api/dashboard derives "my deals" from that header (see below). A snapshot
    // only carries the portal-wide deal set.
    const categories = await fetchCategories();
    // Default funnel: the one whose name contains "продажи услуг", else the shared
    // funnel categoryId 0 (the portal's main "Продажи (общее)" funnel, which is not
    // returned by the category list), else the first listed category.
    const byName = categories.items.find((c) =>
      c.name && c.name.toLowerCase().includes("продажи услуг"),
    );
    const target = byName || { id: 0 };
    const deals = await fetchAllDeals(target.id);
    // Stage dictionary: map every DEAL_STAGE* statusId to its human-readable name.
    // This is what turns codes like "C6:5" / "ANOTHER_PRODUCT" into real stage names.
    const stages = await fetchStageStatuses();
    // User dictionary: id -> full name, to show the responsible person's name.
    const users = await fetchUsers();
    snapshot.data = {
      me: { id: null },
      deals,
      categories: categories.items,
      categoriesSource: categories.source,
      stages,
      users,
      defaultCategoryId: target.id,
    };
    snapshot.at = Date.now();
    snapshot.error = null;
  } catch (err) {
    snapshot.error = { kind: err.kind || "portal_error", message: err.message };
    console.log(`[snapshot] refresh failed: ${snapshot.error.kind} — ${err.message}`);
  } finally {
    snapshot.building = false;
  }
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }

  if (url.pathname === "/api/dashboard") {
    // Identity of the signed-in visitor, injected by the platform gateway. Only a
    // pure numeric value is usable as a Bitrix24 user id for filtering "my deals".
    const vibeUid = req.headers["x-vibe-user-id"];
    const meId = typeof vibeUid === "string" && /^[0-9]+$/.test(vibeUid) ? Number(vibeUid) : null;
    const meta = {
      updatedAt: snapshot.at ? new Date(snapshot.at).toISOString() : null,
      ageMs: snapshot.at ? Date.now() - snapshot.at : null,
      building: snapshot.building,
      warning: snapshot.error ? TEXT_BY_KIND[snapshot.error.kind] : null,
      portalDomain: PORTAL_DOMAIN,
    };
    if (snapshot.data) {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ...snapshot.data, me: { id: meId }, meta }));
      return;
    }
    const kind = snapshot.error?.kind ?? (KEY && BASE ? "loading" : "no_key");
    if (kind === "loading") {
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Данные ещё загружаются. Портал отвечает медленно, подождите.", meta }));
      return;
    }
    res.writeHead(HTTP_BY_KIND[kind] || 500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: TEXT_BY_KIND[kind], kind, meta }));
    return;
  }

  if (url.pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      keyPresent: Boolean(KEY),
      keySource: KEY ? (KEY_FROM_ENVIRONMENT ? "environment" : ENV_FILE) : null,
      baseUrlPresent: Boolean(BASE),
      portalTimeoutMs: PORTAL_TIMEOUT_MS,
      snapshot: { updatedAt: snapshot.at ? new Date(snapshot.at).toISOString() : null, building: snapshot.building, lastError: snapshot.error },
    }));
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
void refresh();
setInterval(() => void refresh(), REFRESH_MS).unref();
