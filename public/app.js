(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const fmtMoney = (n, cur) => {
    const v = Number(n) || 0;
    const parts = new Intl.NumberFormat("ru-RU", {
      maximumFractionDigits: 0,
    }).format(v);
    return `${parts}${cur ? " " + cur : ""}`;
  };
  const fmtDate = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("ru-RU");
  };
  const fmtAge = (ms) => {
    if (ms == null) return "—";
    const min = Math.max(0, Math.round(ms / 60000));
    if (min < 1) return "только что";
    if (min < 60) return `обновлено ${min} мин назад`;
    const h = Math.round(min / 60);
    return `обновлено ${h} ч назад`;
  };

  // Bitrix deal stages: semantic meaning by stageId prefix. Keys are structured
  // "key", "key_EXTRA", "PREPARE". Prefix match covers the common conventions.
  const semanticOf = (stageId) => {
    if (!stageId) return "process";
    // Prefer the authoritative semantics from the portal status dictionary
    // (S = success, F = failure, P = in progress) when we have it.
    const entry = state.data && state.data.stages && state.data.stages.map &&
      state.data.stages.map[String(stageId)];
    if (entry && entry.semantics) {
      if (entry.semantics === "S") return "success";
      if (entry.semantics === "F") return "failed";
      if (entry.semantics === "P") return "process";
    }
    const s = String(stageId).toUpperCase();
    if (s.startsWith("WON") || s === "SUCCESS" || s === "C1") return "success";
    if (s.startsWith("LOSE") || s === "FAILED" || s.startsWith("F")) return "failed";
    if (s === "NEW" || s.startsWith("PREPARE") || s.startsWith("EXECUTING") || s.startsWith("FINAL_INVOICE")) return "process";
    return "process";
  };

  const stageName = (stageId) => {
    if (!stageId) return "Без стадии";
    const s = String(stageId);
    // Prefer the real label from the portal stage dictionary (server snapshot):
    // this resolves custom codes like "C6:5", "C123:2", "ANOTHER_PRODUCT".
    if (state.data && state.data.stages && state.data.stages.map) {
      const entry = state.data.stages.map[s];
      if (entry && entry.name) return entry.name;
    }
    const map = {
      NEW: "Новая",
      PREPARATION: "Подготовка",
      PREPARE: "Подготовка",
      EXECUTING: "В работе",
      FINAL_INVOICE: "Финал. счёт",
      WON: "Успешно",
      SUCCESS: "Успешно",
      C1: "Успешно",
      LOSE: "Провал",
      FAILED: "Провал",
      F: "Провал",
    };
    if (map[s]) return map[s];
    // e.g. "C1:NEW", "20:PREPARE" (smart pipelines) -> take readable tail
    const tail = s.includes(":") ? s.split(":").pop() : s;
    if (map[tail]) return map[tail];
    if (tail.startsWith("WON")) return "Выиграна";
    if (tail.startsWith("LOSE") || tail.startsWith("FAILED") || tail.startsWith("F")) return "Проиграна";
    if (tail.startsWith("NEW")) return "Новая";
    if (tail.startsWith("PREPARE") || tail.startsWith("PREPARATION")) return "Подготовка";
    if (tail.startsWith("EXECUTING")) return "В работе";
    if (tail.startsWith("FINAL_INVOICE")) return "Финал. счёт";
    return s;
  };

  const state = {
    data: null,
    scope: "all", // all | mine
    period: "all",
    category: "", // "" = all funnels, otherwise a categoryId
    stage: "", // "" = all stages, otherwise a stageId
    recentSort: { key: "createdAt", dir: -1 }, // -1 desc (default), 1 asc
  };

  const els = {
    kpi: $("#kpi"),
    funnel: $("#funnel"),
    recentBody: $("#recentBody"),
    recentHint: $("#recentHint"),
    updatedAt: $("#updatedAt"),
    warning: $("#warning"),
    stateBox: $("#state"),
    toast: $("#toast"),
    period: $("#period"),
    category: $("#category"),
    stage: $("#stage"),
    themeToggle: $("#themeToggle"),
  };

  const meId = () => (state.data && state.data.me ? Number(state.data.me.id) : null);

  const periodFrom = (period) => {
    const now = Date.now();
    switch (period) {
      case "30": return now - 30 * 86400000;
      case "90": return now - 90 * 86400000;
      case "180": return now - 180 * 86400000;
      case "year": {
        const d = new Date();
        return new Date(d.getFullYear(), 0, 1).getTime();
      }
      default: return 0;
    }
  };

  const inWindow = (deal) => {
    const from = periodFrom(state.period);
    if (!from) return true;
    const t = deal.createdTs ?? Date.parse(deal.createdAt || "");
    return !Number.isNaN(t) && t >= from;
  };

  const inScope = (deal) => {
    if (state.scope === "mine") {
      return Number(deal.assignedById) === meId();
    }
    return true;
  };

  const inCategory = (deal) => {
    if (!state.category) return true;
    return String(deal.categoryId) === String(state.category);
  };

  const inStage = (deal) => {
    if (!state.stage) return true;
    return String(deal.stageId) === String(state.stage);
  };

  const visible = () => {
    const deals = (state.data && state.data.deals) || [];
    return deals.filter((d) => inWindow(d) && inScope(d) && inCategory(d) && inStage(d));
  };

  const startedDeals = (ds) => ds.filter((d) => !d.closed);
  const wonDeals = (ds) => ds.filter((d) => semanticOf(d.stageId) === "success");

  // ---- render ----
  function renderKpi(ds) {
    const open = startedDeals(ds);
    const openSum = open.reduce((s, d) => s + (Number(d.amount) || 0), 0);
    const won = wonDeals(ds);
    const wonSum = won.reduce((s, d) => s + (Number(d.amount) || 0), 0);
    const avg = won.length ? wonSum / won.length : 0;
    const cur = ds[0]?.currency || "";

    const items = [
      {
        label: "Сумма открытых сделок",
        value: fmtMoney(openSum, cur),
        meta: `${open.length} сделок в работе`,
        metaCls: "dim",
      },
      {
        label: "Выиграно за период",
        value: String(won.length),
        meta: `на ${fmtMoney(wonSum, cur)}`,
        metaCls: "good",
      },
      {
        label: "Средний чек (выигранные)",
        value: fmtMoney(avg, cur),
        meta: won.length ? `по ${won.length} сделкам` : "нет выигранных",
        metaCls: "dim",
      },
    ];

    els.kpi.textContent = "";
    for (const it of items) {
      const card = document.createElement("div");
      card.className = "kpi__card";
      const label = document.createElement("div");
      label.className = "kpi__label";
      label.textContent = it.label;
      const value = document.createElement("div");
      value.className = "kpi__value";
      value.textContent = it.value;
      const meta = document.createElement("div");
      meta.className = "kpi__meta";
      const span = document.createElement("span");
      span.className = it.metaCls;
      span.textContent = it.meta;
      meta.appendChild(span);
      card.append(label, value, meta);
      els.kpi.appendChild(card);
    }
  }

  // The order a stage appears in — taken from the portal status dictionary `sort`
  // so the funnel mirrors the kanban column order on the portal. Unknown stages
  // (no dictionary entry) sort last, in the order they first appeared.
  function orderOf(stageId) {
    const entry = state.data && state.data.stages && state.data.stages.map &&
      state.data.stages.map[stageId];
    return (entry && typeof entry.sort === "number") ? entry.sort : 9999;
  }

  function renderFunnel(ds) {
    const groups = new Map();
    for (const d of ds) {
      const key = d.stageId || "none";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(d);
    }
    const rows = [...groups.entries()].map(([id, list]) => {
      const sum = list.reduce((s, d) => s + (Number(d.amount) || 0), 0);
      return { id, count: list.length, sum };
    }).sort((a, b) => orderOf(a.id) - orderOf(b.id));

    const max = rows.length ? Math.max(...rows.map((r) => r.count)) : 1;
    els.funnel.textContent = "";
    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "funnel__empty";
      empty.textContent = "Нет сделок за выбранный период";
      els.funnel.appendChild(empty);
      return;
    }

    rows.forEach((r, i) => {
      const sem = semanticOf(r.id);
      const row = document.createElement("div");
      row.className = "funnel__row" +
        (sem === "success" ? " funnel__row--success" : "") +
        (sem === "failed" ? " funnel__row--failed" : "");
      row.style.animationDelay = `${i * 0.04}s`;

      const head = document.createElement("div");
      head.className = "funnel__row-head";
      const stage = document.createElement("span");
      stage.className = "funnel__stage" +
        (sem === "success" ? " funnel__stage--semantic-success" : "") +
        (sem === "failed" ? " funnel__stage--semantic-failed" : "");
      stage.textContent = stageName(r.id);
      const num = document.createElement("span");
      num.className = "funnel__num";
      num.textContent = `${r.count} ${plural(r.count, "сделка", "сделки", "сделок")}`;
      head.append(stage, num);

      const bar = document.createElement("div");
      bar.className = "funnel__bar";
      const fill = document.createElement("div");
      fill.className = "funnel__bar-fill";
      fill.style.width = `${Math.round((r.count / max) * 100)}%`;
      bar.appendChild(fill);

      const money = document.createElement("div");
      money.className = "funnel__money";
      money.textContent = fmtMoney(r.sum, ds[0]?.currency || "");

      row.append(head, bar, money);
      els.funnel.appendChild(row);
    });
  }

  // Extract a comparable value for a recent-deals sort key.
  // Human-readable name of the responsible person: prefer the portal user dictionary,
  // fall back to the portal-provided name, then to the numeric id.
  function assigneeName(d) {
    const id = d.assignedById;
    if (id != null && state.data && state.data.users) {
      const n = state.data.users[String(id)];
      if (n) return n;
    }
    if (d.responsibleName) return d.responsibleName;
    return id != null ? `#${id}` : "—";
  }

  function sortKeyValue(d, key) {
    switch (key) {
      case "title": return (d.title || "").toLowerCase();
      case "amount": return Number(d.amount) || 0;
      case "stage": return stageName(d.stageId).toLowerCase();
      case "assignee": return assigneeName(d).toLowerCase();
      case "createdAt": return Date.parse(d.createdAt || "") || 0;
      default: return 0;
    }
  }

  function renderRecent(ds) {
    const cur = ds[0]?.currency || "";
    const { key, dir } = state.recentSort;
    const sorted = [...ds].sort((a, b) => {
      const va = sortKeyValue(a, key);
      const vb = sortKeyValue(b, key);
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      // stable tie-break by id desc
      return (Number(b.id) || 0) - (Number(a.id) || 0);
    });
    const list = sorted.slice(0, 15);

    els.recentHint.textContent = `последние ${list.length} из ${ds.length}`;
    els.recentBody.textContent = "";
    if (!list.length) {
      const empty = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 5;
      td.className = "recent__empty";
      td.textContent = "Нет сделок за выбранный период";
      empty.appendChild(td);
      els.recentBody.appendChild(empty);
      return;
    }

    for (const d of list) {
      const tr = document.createElement("tr");

      const tdTitle = document.createElement("td");
      const titleDiv = document.createElement("div");
      titleDiv.className = "recent__title";
      const id = d.id;
      const domain = state.data.meta?.portalDomain;
      if (domain && id) {
        const a = document.createElement("a");
        a.href = `https://${domain}/crm/deal/details/${id}/`;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = d.title || `Сделка #${id}`;
        titleDiv.appendChild(a);
      } else {
        titleDiv.textContent = d.title || `Сделка #${id}`;
      }
      tdTitle.appendChild(titleDiv);

      const tdMoney = document.createElement("td");
      tdMoney.className = "recent__money";
      tdMoney.textContent = fmtMoney(d.amount, cur);

      const tdStage = document.createElement("td");
      const chip = document.createElement("span");
      const sem = semanticOf(d.stageId);
      chip.className = "stage-chip" +
        (sem === "success" ? " stage-chip--success" : "") +
        (sem === "failed" ? " stage-chip--failed" : "");
      chip.textContent = stageName(d.stageId);
      tdStage.appendChild(chip);

      const tdAsg = document.createElement("td");
      const asgDiv = document.createElement("div");
      asgDiv.className = "recent__assignee";
      asgDiv.textContent = assigneeName(d);
      tdAsg.appendChild(asgDiv);

      const tdDate = document.createElement("td");
      tdDate.className = "recent__date";
      tdDate.textContent = fmtDate(d.createdAt);

      tr.append(tdTitle, tdMoney, tdStage, tdAsg, tdDate);
      els.recentBody.appendChild(tr);
    }
  }

  // Refresh the ▲/▼ markers in the recent-deals table header for the active sort key.
  function updateSortIndicators() {
    document.querySelectorAll(".recent__table th.sortable").forEach((th) => {
      const ind = th.querySelector(".sortable__ind");
      if (!ind) return;
      if (th.dataset.sort === state.recentSort.key) {
        ind.textContent = state.recentSort.dir < 0 ? " ▲" : " ▼";
        th.classList.add("is-sorted");
      } else {
        ind.textContent = "";
        th.classList.remove("is-sorted");
      }
    });
  }

  function plural(n, one, few, many) {
    const n10 = n % 10;
    const n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return one;
    if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
    return many;
  }

  // Fill the stage dropdown with the distinct stages present in the current deal set
  // (ignoring the stage filter itself, so the list does not collapse on selection).
  // Order follows the portal kanban order from the stage dictionary.
  function fillStageSelect() {
    const deals = (state.data && state.data.deals) || [];
    const base = deals.filter((d) => inWindow(d) && inScope(d) && inCategory(d));
    const seen = new Set();
    const stages = [];
    for (const d of base) {
      const id = d.stageId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      stages.push(id);
    }
    stages.sort((a, b) => orderOf(a) - orderOf(b));

    const current = state.stage;
    els.stage.textContent = "";
    const optAll = document.createElement("option");
    optAll.value = "";
    optAll.textContent = "Все стадии";
    els.stage.appendChild(optAll);
    for (const id of stages) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = stageName(id);
      els.stage.appendChild(opt);
    }
    // keep the previous selection if it is still present, else reset to "all"
    const exists = Array.from(els.stage.options).some((o) => o.value === String(current));
    state.stage = current && exists ? current : "";
    els.stage.value = state.stage;
  }

  function render() {
    if (!state.data || !state.data.deals) {
      renderState("Ожидание данных", "Дашборд загружается…");
      return;
    }
    const ds = visible();
    els.stateBox.hidden = true;
    els.stateBox.textContent = "";
    fillStageSelect();
    renderKpi(ds);
    renderFunnel(ds);
    renderRecent(ds);
    updateSortIndicators();
    els.updatedAt.textContent = fmtAge(state.data.meta?.ageMs);
    if (state.data.meta?.warning) {
      els.warning.textContent = state.data.meta.warning;
      els.warning.hidden = false;
    } else {
      els.warning.hidden = true;
    }
  }

  function renderState(title, text) {
    els.stateBox.hidden = false;
    els.stateBox.innerHTML = "";
    const h = document.createElement("h2");
    h.className = "state__title";
    h.textContent = title;
    const p = document.createElement("p");
    p.textContent = text;
    els.stateBox.append(h, p);
  }

  function showToast(msg, isWarn) {
    els.toast.textContent = msg;
    els.toast.classList.toggle("warn", Boolean(isWarn));
    els.toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { els.toast.hidden = true; }, 6000);
  }

  // Fill the funnel dropdown from the portal category list and select a funnel by
  // default. Priority: keep the user's previous selection → server's
  // defaultCategoryId (the "Продажи (общее)" funnel, categoryId 0) → name match
  // → all funnels.
  function fillCategorySelect() {
    const cats = (state.data && state.data.categories) || [];
    const current = state.category;
    const serverDefault = state.data && state.data.defaultCategoryId != null
      ? String(state.data.defaultCategoryId)
      : "";
    els.category.textContent = "";
    const optAll = document.createElement("option");
    optAll.value = "";
    optAll.textContent = "Все воронки";
    els.category.appendChild(optAll);
    // The shared funnel (categoryId 0) is not returned by the category endpoint,
    // so offer it explicitly as "Общая воронка" when it is not already listed.
    if (!cats.some((c) => String(c.id) === "0")) {
      const opt0 = document.createElement("option");
      opt0.value = "0";
      opt0.textContent = "Общая (продажи услуг)";
      els.category.appendChild(opt0);
    }
    for (const c of cats) {
      const opt = document.createElement("option");
      opt.value = String(c.id);
      opt.textContent = c.name;
      els.category.appendChild(opt);
    }
    let next = "";
    const exists = (v) =>
      Array.from(els.category.options).some((o) => o.value === String(v));
    if (current !== "" && exists(current)) {
      next = String(current);
    } else if (serverDefault !== "" && exists(serverDefault)) {
      next = serverDefault;
    } else {
      const match = cats.find((c) =>
        c.name && c.name.toLowerCase().includes("продажи услуг"),
      );
      if (match) next = String(match.id);
    }
    state.category = next;
    els.category.value = next;
  }

  async function load() {
    renderState("Загрузка", "Дашборд обращается к порталу…");
    let res;
    try {
      res = await fetch("/api/dashboard", { cache: "no-store" });
    } catch {
      renderState("Нет связи", "Не удалось связаться с сервером приложения.");
      return;
    }
    let json = null;
    try { json = await res.json(); } catch { json = null; }

    if (res.status === 202) {
      renderState("Данные ещё загружаются", json?.error || "Портал отвечает медленно, подождите.");
      setTimeout(load, 3000);
      return;
    }
    if (!res.ok) {
      const kind = json?.kind;
      renderState("Не удалось получить данные", json?.error || `Ошибка ${res.status}`);
      if (kind === "no_key" || kind === "denied") {
        // These two kinds are the only ones allowed to mention the key.
        showToast(json?.error, true);
      }
      if (kind === "loading") setTimeout(load, 3000);
      return;
    }

    state.data = json;
    fillCategorySelect();
    render();
  }

  // ---- events ----
  document.querySelectorAll(".seg").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.scope = btn.dataset.scope;
      document.querySelectorAll(".seg").forEach((b) => {
        b.setAttribute("aria-pressed", String(b === btn));
      });
      render();
    });
  });

  els.period.addEventListener("change", (e) => {
    state.period = e.target.value;
    render();
  });

  els.category.addEventListener("change", (e) => {
    state.category = e.target.value;
    render();
  });

  els.stage.addEventListener("change", (e) => {
    state.stage = e.target.value;
    render();
  });

  // Theme toggle: dark / light. Persisted in localStorage; also update the button state.
  els.themeToggle.addEventListener("click", () => {
    const root = document.documentElement;
    const next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("crm-dash-theme", next); } catch (e) { /* ignore */ }
    els.themeToggle.setAttribute("aria-pressed", String(next === "light"));
  });

  // Column sorting in "Последние сделки": click a header to sort by that column,
  // click again to reverse direction.
  document.querySelectorAll(".recent__table th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (state.recentSort.key === key) {
        state.recentSort.dir *= -1;
      } else {
        state.recentSort.key = key;
        // sensible defaults per column
        state.recentSort.dir = (key === "title" || key === "stage" || key === "assignee") ? 1 : -1;
      }
      render();
    });
  });

  // auto-refresh every 60s so the timestamp stays honest while the page is open
  setInterval(() => {
    if (state.data) render();
  }, 60000);

  load();
})();
