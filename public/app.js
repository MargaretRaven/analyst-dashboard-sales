(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const fmtMoney = (n, cur) => {
    const v = Number(n) || 0;
    const parts = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(v);
    return `${parts}${cur ? " " + cur : ""}`;
  };
  const fmtDate = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("ru-RU");
  };

  // Semantics from the portal stage dictionary, else convention-based fallback.
  const semanticOf = (stageId) => {
    if (!stageId) return "process";
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
    return "process";
  };

  const stageName = (stageId) => {
    if (!stageId) return "Без стадии";
    const s = String(stageId);
    if (state.data && state.data.stages && state.data.stages.map) {
      const entry = state.data.stages.map[s];
      if (entry && entry.name) return entry.name;
    }
    const map = {
      NEW: "Новая", PREPARATION: "Подготовка", PREPARE: "Подготовка",
      EXECUTING: "В работе", FINAL_INVOICE: "Финал. счёт", WON: "Успешно",
      SUCCESS: "Успешно", C1: "Успешно", LOSE: "Провал", FAILED: "Провал", F: "Провал",
    };
    if (map[s]) return map[s];
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

  const assigneeName = (d) => {
    const id = d.assignedById;
    if (id != null && state.data && state.data.users) {
      const n = state.data.users[String(id)];
      if (n) return n;
    }
    return id != null ? `#${id}` : "—";
  };

  const state = {
    data: null,
    scope: "all", // all | mine
    period: "all",
    category: "", // "" = all funnels, otherwise a categoryId
    stage: "", // "" = all stages, otherwise a stageId
    recentSort: { key: "createdAt", dir: -1 },
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

  const orderOf = (stageId) => {
    const entry = state.data && state.data.stages && state.data.stages.map &&
      state.data.stages.map[stageId];
    return (entry && typeof entry.sort === "number") ? entry.sort : 9999;
  };

  // ---------- render ----------
  function renderKpi(kpi) {
    const cur = ""; // currency is per-deal; totals are mixed-portal, show no single suffix
    const items = [
      { label: "Сумма открытых сделок", value: fmtMoney(kpi.openSum, cur), meta: `${kpi.openCount} сделок в работе`, metaCls: "dim" },
      { label: "Выиграно за период", value: String(kpi.wonCount), meta: `на ${fmtMoney(kpi.wonSum, cur)}`, metaCls: "good" },
      { label: "Средний чек (выигранные)", value: fmtMoney(kpi.avg, cur), meta: kpi.wonCount ? `по ${kpi.wonCount} сделкам` : "нет выигранных", metaCls: "dim" },
    ];
    els.kpi.textContent = "";
    for (const it of items) {
      const card = document.createElement("div");
      card.className = "kpi__card";
      const label = document.createElement("div"); label.className = "kpi__label"; label.textContent = it.label;
      const value = document.createElement("div"); value.className = "kpi__value"; value.textContent = it.value;
      const meta = document.createElement("div"); meta.className = "kpi__meta";
      const span = document.createElement("span"); span.className = it.metaCls; span.textContent = it.meta;
      meta.appendChild(span);
      card.append(label, value, meta);
      els.kpi.appendChild(card);
    }
  }

  function renderFunnel(funnel) {
    const max = funnel.length ? Math.max(...funnel.map((r) => r.count)) : 1;
    els.funnel.textContent = "";
    if (!funnel.length) {
      const empty = document.createElement("div");
      empty.className = "funnel__empty";
      empty.textContent = "Нет сделок за выбранный период";
      els.funnel.appendChild(empty);
      return;
    }
    const rows = [...funnel].sort((a, b) => orderOf(a.stageId) - orderOf(b.stageId));
    rows.forEach((r, i) => {
      const sem = semanticOf(r.stageId);
      const row = document.createElement("div");
      row.className = "funnel__row" +
        (sem === "success" ? " funnel__row--success" : "") +
        (sem === "failed" ? " funnel__row--failed" : "");
      row.style.animationDelay = `${i * 0.04}s`;

      const head = document.createElement("div"); head.className = "funnel__row-head";
      const stage = document.createElement("span");
      stage.className = "funnel__stage" +
        (sem === "success" ? " funnel__stage--semantic-success" : "") +
        (sem === "failed" ? " funnel__stage--semantic-failed" : "");
      stage.textContent = stageName(r.stageId);
      const num = document.createElement("span"); num.className = "funnel__num";
      num.textContent = `${r.count} ${plural(r.count, "сделка", "сделки", "сделок")}`;
      head.append(stage, num);

      const bar = document.createElement("div"); bar.className = "funnel__bar";
      const fill = document.createElement("div"); fill.className = "funnel__bar-fill";
      fill.style.width = `${Math.round((r.count / max) * 100)}%`;
      bar.appendChild(fill);

      const money = document.createElement("div"); money.className = "funnel__money";
      money.textContent = fmtMoney(r.sum, "");

      row.append(head, bar, money);
      els.funnel.appendChild(row);
    });
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

  function renderRecent(recent) {
    const { key, dir } = state.recentSort;
    const list = [...recent].sort((a, b) => {
      const va = sortKeyValue(a, key);
      const vb = sortKeyValue(b, key);
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return (Number(b.id) || 0) - (Number(a.id) || 0);
    });
    els.recentHint.textContent = `последние ${list.length}`;
    els.recentBody.textContent = "";
    if (!list.length) {
      const empty = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 5; td.className = "recent__empty";
      td.textContent = "Нет сделок за выбранный период";
      empty.appendChild(td);
      els.recentBody.appendChild(empty);
      return;
    }
    const domain = state.data.meta?.portalDomain;
    for (const d of list) {
      const tr = document.createElement("tr");
      const tdTitle = document.createElement("td");
      const titleDiv = document.createElement("div"); titleDiv.className = "recent__title";
      if (domain && d.id) {
        const a = document.createElement("a");
        a.href = `https://${domain}/crm/deal/details/${d.id}/`;
        a.target = "_blank"; a.rel = "noopener";
        a.textContent = d.title || `Сделка #${d.id}`;
        titleDiv.appendChild(a);
      } else {
        titleDiv.textContent = d.title || `Сделка #${d.id}`;
      }
      tdTitle.appendChild(titleDiv);

      const tdMoney = document.createElement("td"); tdMoney.className = "recent__money";
      tdMoney.textContent = fmtMoney(d.amount, "");

      const tdStage = document.createElement("td");
      const chip = document.createElement("span");
      const sem = semanticOf(d.stageId);
      chip.className = "stage-chip" +
        (sem === "success" ? " stage-chip--success" : "") +
        (sem === "failed" ? " stage-chip--failed" : "");
      chip.textContent = stageName(d.stageId);
      tdStage.appendChild(chip);

      const tdAsg = document.createElement("td");
      const asgDiv = document.createElement("div"); asgDiv.className = "recent__assignee";
      asgDiv.textContent = assigneeName(d);
      tdAsg.appendChild(asgDiv);

      const tdDate = document.createElement("td"); tdDate.className = "recent__date";
      tdDate.textContent = fmtDate(d.createdAt);

      tr.append(tdTitle, tdMoney, tdStage, tdAsg, tdDate);
      els.recentBody.appendChild(tr);
    }
  }

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
    const n10 = n % 10, n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return one;
    if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
    return many;
  }

  // Fill the funnel dropdown from the server category list; select the shared funnel
  // (categoryId 0 = "Продажи услуг (общее)") by default, keep the user's choice.
  function fillCategorySelect() {
    const cats = (state.data && state.data.categories) || [];
    const current = state.category;
    els.category.textContent = "";
    const optAll = document.createElement("option"); optAll.value = ""; optAll.textContent = "Все воронки";
    els.category.appendChild(optAll);
    if (!cats.some((c) => String(c.id) === "0")) {
      const opt0 = document.createElement("option"); opt0.value = "0"; opt0.textContent = "Общая (продажи услуг)";
      els.category.appendChild(opt0);
    }
    for (const c of cats) {
      const opt = document.createElement("option"); opt.value = String(c.id); opt.textContent = c.name;
      els.category.appendChild(opt);
    }
    const exists = (v) => Array.from(els.category.options).some((o) => o.value === String(v));
    let next = "";
    if (current !== "" && exists(current)) next = String(current);
    else if (exists("0")) next = "0";
    const match = cats.find((c) => c.name && c.name.toLowerCase().includes("продажи услуг"));
    if (next === "" && match) next = String(match.id);
    state.category = next;
    els.category.value = next;
  }

  // Fill the stage dropdown from the stage dictionary limited to the selected funnel.
  function fillStageSelect() {
    const items = (state.data && state.data.stages && state.data.stages.items) || [];
    const cat = state.category || "";
    const sel = cat ? items.filter((s) => String(s.categoryId) === String(cat) || String(s.categoryId) === cat)
      : items;
    const seen = new Set();
    const stages = [];
    for (const s of sel) {
      if (!s.statusId || seen.has(s.statusId)) continue;
      seen.add(s.statusId);
      stages.push(s.statusId);
    }
    stages.sort((a, b) => orderOf(a) - orderOf(b));
    const current = state.stage;
    els.stage.textContent = "";
    const optAll = document.createElement("option"); optAll.value = ""; optAll.textContent = "Все стадии";
    els.stage.appendChild(optAll);
    for (const id of stages) {
      const opt = document.createElement("option"); opt.value = id; opt.textContent = stageName(id);
      els.stage.appendChild(opt);
    }
    const exists = Array.from(els.stage.options).some((o) => o.value === String(current));
    state.stage = current && exists ? current : "";
    els.stage.value = state.stage;
  }

  function render() {
    if (!state.data) { renderState("Ожидание данных", "Дашборд загружается…"); return; }
    els.stateBox.hidden = true;
    els.stateBox.textContent = "";
    renderKpi(state.data.kpi || {});
    renderFunnel(state.data.funnel || []);
    renderRecent(state.data.recent || []);
    updateSortIndicators();
    els.updatedAt.textContent = state.data.meta?.updatedAtDisplay || "—";
    if (state.data.truncated) {
      els.warning.textContent = "Данные агрегированы по части записей (потолок выборки).";
      els.warning.hidden = false;
    } else {
      els.warning.hidden = true;
    }
  }

  function renderState(title, text) {
    els.stateBox.hidden = false;
    els.stateBox.innerHTML = "";
    const h = document.createElement("h2"); h.className = "state__title"; h.textContent = title;
    const p = document.createElement("p"); p.textContent = text;
    els.stateBox.append(h, p);
  }

  function showToast(msg, isWarn) {
    els.toast.textContent = msg;
    els.toast.classList.toggle("warn", Boolean(isWarn));
    els.toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { els.toast.hidden = true; }, 6000);
  }

  function qs() {
    const p = new URLSearchParams();
    p.set("period", state.period);
    p.set("scope", state.scope);
    if (state.category) p.set("category", state.category);
    if (state.stage) p.set("stage", state.stage);
    return p.toString();
  }

  async function load() {
    renderState("Загрузка", "Дашборд обращается к порталу…");
    let res;
    try {
      res = await fetch(`/api/dashboard?${qs()}`, { cache: "no-store" });
    } catch {
      renderState("Нет связи", "Не удалось связаться с сервером приложения.");
      return;
    }
    let json = null;
    try { json = await res.json(); } catch { json = null; }

    if (res.status === 401) {
      renderState("Требуется вход", json?.error || "Сессия платформы не обнаружена.");
      return;
    }
    if (!res.ok) {
      const kind = json?.kind;
      renderState("Не удалось получить данные", json?.error || `Ошибка ${res.status}`);
      if (kind === "no_key" || kind === "denied") showToast(json?.error, true);
      return;
    }
    json.meta = json.meta || {};
    json.meta.updatedAtDisplay = "обновлено сейчас";
    state.data = json;
    fillCategorySelect();
    fillStageSelect();
    render();
  }

  // ---- events ----
  document.querySelectorAll(".seg").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.scope = btn.dataset.scope;
      document.querySelectorAll(".seg").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
      load();
    });
  });
  els.period.addEventListener("change", (e) => { state.period = e.target.value; load(); });
  els.category.addEventListener("change", (e) => { state.category = e.target.value; state.stage = ""; load(); });
  els.stage.addEventListener("change", (e) => { state.stage = e.target.value; load(); });

  els.themeToggle.addEventListener("click", () => {
    const root = document.documentElement;
    const next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("crm-dash-theme", next); } catch (e) { /* ignore */ }
    els.themeToggle.setAttribute("aria-pressed", String(next === "light"));
  });

  document.querySelectorAll(".recent__table th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (state.recentSort.key === key) { state.recentSort.dir *= -1; }
      else { state.recentSort.key = key; state.recentSort.dir = (key === "title" || key === "stage" || key === "assignee") ? 1 : -1; }
      render();
    });
  });

  load();
})();
