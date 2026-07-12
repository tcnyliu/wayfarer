/* ============================================================
   Wayfarer — app logic
   ============================================================ */
"use strict";

const STORE_KEY = "wayfarer.trip.v1";
const CACHE_KEY = "wayfarer.poi.v1";
const POI_TTL_MS = 7 * 24 * 3600 * 1000;

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

/* ---------------- state ---------------- */

let state = loadTrip();
let selectedStopId = null;
let exploreStopId = null;
let exploreTab = "hostels";
let map = null;
let mapLayer = null;
let dragIndex = null;
let dropTarget = null;
let searchHl = -1;
let lastBounds = null;
let mapHadSize = false;
const FIT_OPTS = { padding: [46, 46], maxZoom: 7, animate: false };

// js/trip.local.js (gitignored, optional) can define window.LOCAL_TRIP to
// preload a personal itinerary without publishing it.
function seedTrip() {
  return structuredClone(window.LOCAL_TRIP ?? DEFAULT_TRIP);
}

function loadTrip() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const t = JSON.parse(raw);
      if (t && Array.isArray(t.stops)) return t;
    }
  } catch (e) { /* fall through to default */ }
  return seedTrip();
}

function saveTrip() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
}

/* ---------------- utils ---------------- */

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function uid() { return "s" + Math.random().toString(36).slice(2, 9); }

function haversineKm(a, b) {
  const R = 6371, d = Math.PI / 180;
  const dLat = (b.lat - a.lat) * d, dLon = (b.lon - a.lon) * d;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * d) * Math.cos(b.lat * d) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function parseDate(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function toISO(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}
function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}
function daysBetween(a, b) { return Math.round((b - a) / 86400000); }

const FMT_SHORT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const FMT_LONG = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" });
function fmtShort(d) { return d ? FMT_SHORT.format(d) : ""; }
function fmtLong(d) { return d ? FMT_LONG.format(d) : ""; }

function normName(name) {
  return String(name).toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\(.*?\)/g, "").split(",")[0].trim();
}

function hoursLabel(h) {
  const hh = Math.floor(h), mm = Math.round((h - hh) * 60);
  return mm ? `${hh}h ${mm}m` : `${hh}h`;
}

function toast(msg, action) {
  const el = $("#toast");
  el.textContent = msg;
  if (action) {
    const btn = document.createElement("button");
    btn.className = "toast-action";
    btn.textContent = action.label;
    btn.addEventListener("click", () => { el.classList.add("hidden"); action.fn(); });
    el.appendChild(btn);
  }
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), action ? 6000 : 2600);
}

/* ---------------- travel estimation ---------------- */

const MODE_ICON = { train: "🚆", bus: "🚌", flight: "✈️", "train+bus": "🚆🚌" };
const MODE_META = {
  train: { label: "Train" },
  bus: { label: "Bus" },
  flight: { label: "Flight" },
  "train+bus": { label: "Train + bus" },
};

// Door-to-door duration heuristics: rail ~95 km/h incl. transfers, coach
// ~72 km/h, flights add ~2.8h of airport overhead on top of air time.
function modeHours(mode, km) {
  if (mode === "flight") return km / 700 + 2.8;
  if (mode === "bus") return km / 72 + 0.5;
  return km / 95 + 0.6;
}

// Rough budget fares in EUR, booked a few weeks ahead (planning numbers,
// not quotes): trains ~€0.11/km, coaches ~€0.055/km, budget flights
// ~€30 base + distance (bags not included).
function modeCost(mode, km) {
  if (mode === "flight") return 30 + 0.05 * km;
  if (mode === "bus") return 4 + 0.055 * km;
  return 6 + 0.11 * km;
}

/**
 * Estimate a leg across all viable modes.
 * Returns { km, options, cheapest, fastest, recommended, chosen fields… }.
 * a.legMode ("train"|"bus"|"flight"), if set, overrides the recommendation.
 */
function estimateLeg(a, b) {
  const km = haversineKm(a, b);
  const key = [normName(a.name), normName(b.name)].sort().join("|");
  const curated = CURATED_LEGS[key];

  const options = {};
  for (const m of ["train", "bus", "flight"]) {
    if (m === "flight" && km < 400) continue; // short hops: flying never wins door-to-door
    options[m] = { mode: m, hours: modeHours(m, km), cost: modeCost(m, km), curated: false, note: null };
  }
  if (curated) {
    const cm = curated.mode === "train+bus" ? "train" : curated.mode;
    if (!options[cm]) options[cm] = { mode: cm, cost: modeCost(cm, km), curated: false, note: null };
    options[cm].hours = curated.hours;
    options[cm].curated = true;
    options[cm].note = curated.note;
  }

  const list = Object.values(options);
  const cheapest = list.reduce((x, y) => (y.cost < x.cost ? y : x));
  const fastest = list.reduce((x, y) => (y.hours < x.hours ? y : x));
  // Recommended: the curated mode when we have real schedule data, otherwise
  // best time/money trade-off valuing a backpacker's hour at ~€15.
  const recommended = curated
    ? options[curated.mode === "train+bus" ? "train" : curated.mode]
    : list.reduce((x, y) => (y.hours * 15 + y.cost < x.hours * 15 + x.cost ? y : x));
  const override = a.legMode && options[a.legMode] ? options[a.legMode] : null;
  const chosen = override ?? recommended;

  return {
    km, options, cheapest, fastest, recommended,
    mode: chosen.mode, hours: chosen.hours, cost: chosen.cost,
    curated: chosen.curated, note: chosen.note, isAuto: !override,
  };
}

function legBookingLink(a, b, mode) {
  if (mode === "flight") {
    const q = encodeURIComponent(`Flights from ${a.name} to ${b.name}`);
    return { label: "Google Flights", url: `https://www.google.com/travel/flights?q=${q}` };
  }
  const enc = (s) => encodeURIComponent(String(s).replace(/\s+/g, "-"));
  return { label: "Rome2Rio", url: `https://www.rome2rio.com/map/${enc(a.name)}/${enc(b.name)}` };
}

/* ---------------- schedule ---------------- */

function computeSchedule() {
  const start = parseDate(state.startDate);
  const end = parseDate(state.endDate);
  const entries = [];
  const warnings = [];
  let cursor = start ? new Date(start) : null;

  state.stops.forEach((stop, i) => {
    const arrival = cursor ? new Date(cursor) : null;
    const departure = cursor ? addDays(arrival, stop.nights) : null;
    let leg = null;
    if (i < state.stops.length - 1) leg = estimateLeg(stop, state.stops[i + 1]);

    let deadlineOk = true;
    if (stop.arriveBy && arrival) {
      deadlineOk = arrival <= parseDate(stop.arriveBy);
      if (!deadlineOk) warnings.push({
        level: "bad",
        text: `${stop.name}: arriving ${fmtLong(arrival)}, after your “arrive by ${fmtShort(parseDate(stop.arriveBy))}” deadline. Cut nights upstream or reorder.`,
      });
    }
    if (leg && leg.hours >= 8.5) warnings.push({
      level: "warn",
      text: `${stop.name} → ${state.stops[i + 1].name} is a long haul (~${hoursLabel(leg.hours)}). Consider a night train or a budget flight.`,
    });

    entries.push({ stop, arrival, departure, leg, deadlineOk, index: i });
    cursor = departure;
  });

  const allocated = state.stops.reduce((s, x) => s + x.nights, 0);
  const available = start && end ? daysBetween(start, end) : 0;
  if (available > 0 && allocated > available) warnings.unshift({
    level: "bad",
    text: `You've allocated ${allocated} nights but the trip only has ${available}. Trim ${allocated - available} night${allocated - available > 1 ? "s" : ""} somewhere.`,
  });
  if (available > 0 && allocated < available) warnings.unshift({
    level: "warn",
    text: `${available - allocated} unallocated night${available - allocated > 1 ? "s" : ""} — hit Auto-balance or add them where you want more time.`,
  });

  return { entries, warnings, allocated, available };
}

/* ---------------- optimizer ---------------- */

function routeCost(order) {
  // order = array of stop objects, endpoints already fixed by caller
  let km = 0;
  for (let i = 0; i < order.length - 1; i++) km += haversineKm(order[i], order[i + 1]);

  // deadline penalty: simulate the calendar over this order
  let penalty = 0;
  const start = parseDate(state.startDate);
  if (start) {
    let cursor = new Date(start);
    for (const stop of order) {
      if (stop.arriveBy && cursor > parseDate(stop.arriveBy)) penalty += 1;
      cursor = addDays(cursor, stop.nights);
    }
  }
  return km + penalty * 100000;
}

function optimizeRoute() {
  if (state.stops.length < 4) { toast("Add more stops to optimize"); return; }
  const first = state.stops[0];
  const last = state.stops[state.stops.length - 1];
  let mid = state.stops.slice(1, -1);

  const before = routeCost(state.stops);

  // 2-opt with deadline-aware cost until no improvement
  let improved = true;
  let best = [first, ...mid, last];
  let bestCost = routeCost(best);
  while (improved) {
    improved = false;
    for (let i = 1; i < best.length - 2; i++) {
      for (let j = i + 1; j < best.length - 1; j++) {
        const cand = best.slice(0, i)
          .concat(best.slice(i, j + 1).reverse(), best.slice(j + 1));
        const c = routeCost(cand);
        if (c < bestCost - 1e-9) { best = cand; bestCost = c; improved = true; }
      }
    }
  }

  const saved = before - bestCost;
  if (saved <= 1) { toast("Route is already optimal"); return; }

  const prevOrder = state.stops.slice();
  state.stops = best;
  saveTrip();
  renderAll(true);
  toast(`Route optimized — saved ~${Math.round(saved)} km`, {
    label: "Undo",
    fn: () => { state.stops = prevOrder; saveTrip(); renderAll(true); },
  });
}

function autoBalanceNights() {
  const start = parseDate(state.startDate), end = parseDate(state.endDate);
  if (!start || !end) { toast("Set trip dates first"); return; }
  const available = daysBetween(start, end);
  let allocated = state.stops.reduce((s, x) => s + x.nights, 0);
  if (allocated === available) { toast("Nights already balanced"); return; }

  const stops = state.stops;
  let guard = 500;
  // round-robin so spare nights spread across cities instead of piling onto one
  let touched = new Set();
  while (allocated < available && guard--) {
    let pool = stops.filter((s) => !touched.has(s.id));
    if (!pool.length) { touched.clear(); pool = stops; }
    const target = pool.reduce((a, b) => (b.nights > a.nights ? b : a));
    target.nights++; allocated++;
    touched.add(target.id);
  }
  touched = new Set();
  while (allocated > available && guard--) {
    let pool = stops.filter((s) => s.nights > 1 && !touched.has(s.id));
    if (!pool.length) { touched.clear(); pool = stops.filter((s) => s.nights > 1); }
    if (!pool.length) break;
    const target = pool.reduce((a, b) => (b.nights > a.nights ? b : a));
    target.nights--; allocated--;
    touched.add(target.id);
  }
  saveTrip();
  renderAll();
  toast(allocated === available ? "Nights balanced to trip length" : "Couldn't fully balance — trim manually");
}

/* ---------------- map ---------------- */

function initMap() {
  if (typeof L === "undefined") return; // offline: Leaflet CDN unavailable
  map = L.map("map", { zoomControl: true, attributionControl: true });
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: "abcd",
    maxZoom: 19,
  }).addTo(map);
  mapLayer = L.layerGroup().addTo(map);
  map.setView([46, 8], 5);

  map.on("popupopen", (e) => {
    const btn = e.popup.getElement().querySelector("[data-explore]");
    if (btn) btn.addEventListener("click", () => openExplore(btn.dataset.explore));
  });

  // The container can be zero-sized while the page is still laying out
  // (or hidden in a background tab) — refit once it gains real dimensions.
  const el = document.getElementById("map");
  new ResizeObserver(() => {
    if (!map) return;
    map.invalidateSize({ animate: false });
    const r = el.getBoundingClientRect();
    const hasSize = r.width > 40 && r.height > 40;
    if (hasSize && !mapHadSize && lastBounds) map.fitBounds(lastBounds, FIT_OPTS);
    if (hasSize) mapHadSize = true;
  }).observe(el);
}

function renderMap(fit = false) {
  if (!map) return;
  mapLayer.clearLayers();
  const { entries } = computeSchedule();
  if (!entries.length) return;

  entries.forEach(({ stop, arrival, departure, index }) => {
    const endpoint = index === 0 || index === entries.length - 1;
    const icon = L.divIcon({
      className: "",
      html: `<div class="map-marker${endpoint ? " endpoint" : ""}">${index + 1}</div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });
    const dates = arrival
      ? `${fmtLong(arrival)}${stop.nights ? " – " + fmtLong(departure) : ""} · ${stop.nights} night${stop.nights === 1 ? "" : "s"}`
      : "";
    const m = L.marker([stop.lat, stop.lon], { icon }).addTo(mapLayer);
    m.bindPopup(
      `<div class="map-pop"><b>${esc(stop.name)}</b>` +
      `<div class="mp-dates">${dates}</div>` +
      `<button data-explore="${stop.id}">Explore hostels, food &amp; sights</button></div>`
    );
  });

  entries.forEach(({ stop, leg }, i) => {
    if (!leg) return;
    const next = entries[i + 1].stop;
    const line = [[stop.lat, stop.lon], [next.lat, next.lon]];
    L.polyline(line, {
      color: "#0f766e",
      weight: 2.5,
      opacity: 0.85,
      dashArray: leg.mode === "flight" ? "6 8" : null,
    }).addTo(mapLayer);
  });

  const bounds = L.latLngBounds(entries.map((e) => [e.stop.lat, e.stop.lon]));
  lastBounds = bounds;
  // only re-zoom when the route's shape changed — not on every nights tweak
  if (fit || !mapHadSize) map.fitBounds(bounds, FIT_OPTS);
}

function panToStop(stop) {
  if (!map) return;
  map.setView([stop.lat, stop.lon], 7, { animate: true });
}

/* ---------------- sidebar render ---------------- */

/**
 * Move a stop from index `from` to sit at slot `insertAt` (an index in the
 * pre-removal list; pass card-index for "before", card-index + 1 for "after").
 * Handles the index shift caused by removing the dragged card first.
 */
function moveStop(from, insertAt) {
  const stops = state.stops;
  if (from < 0 || from >= stops.length) return;
  let to = Math.max(0, Math.min(stops.length, insertAt));
  if (from < to) to--;
  if (to === from) return;
  const [moved] = stops.splice(from, 1);
  stops.splice(to, 0, moved);
  saveTrip();
  renderAll(true);
}

function renderStops() {
  const { entries } = computeSchedule();
  const wrap = $("#stops-list");
  wrap.innerHTML = "";

  entries.forEach(({ stop, arrival, departure, leg, deadlineOk, index }) => {
    const card = document.createElement("div");
    const isStart = index === 0, isEnd = index === entries.length - 1;
    card.className = "stop-card" + (isStart ? " is-start" : "") + (isEnd ? " is-end" : "") +
      (stop.id === selectedStopId ? " selected" : "");
    // draggable is armed on drag-handle mousedown (see initEvents) so text
    // selection and the date input keep working inside the card
    card.dataset.index = index;
    card.dataset.id = stop.id;

    const dates = arrival
      ? (stop.nights
          ? `${fmtShort(arrival)} – ${fmtShort(departure)}`
          : fmtShort(arrival))
      : "";

    const badges = [];
    if (isStart) badges.push(`<span class="badge ok">Start</span>`);
    if (isEnd) badges.push(`<span class="badge ok">End</span>`);
    if (stop.arriveBy) badges.push(
      `<span class="badge ${deadlineOk ? "ok" : "bad"}">${deadlineOk ? "✓" : "✕"} by ${fmtShort(parseDate(stop.arriveBy))}</span>`);

    card.innerHTML = `
      <div class="stop-row1">
        <span class="stop-num">${index + 1}</span>
        <span class="stop-name" title="${esc(stop.name)}${stop.country ? ", " + esc(stop.country) : ""}">${esc(stop.name)}</span>
        <span class="stop-dates">${dates}</span>
        <button class="icon-btn mini" data-act="up" title="Move up" ${index === 0 ? "disabled" : ""}>▲</button>
        <button class="icon-btn mini" data-act="down" title="Move down" ${isEnd ? "disabled" : ""}>▼</button>
        <button class="drag-handle" title="Drag to reorder">⠿</button>
      </div>
      <div class="stop-row2">
        <span class="nights-stepper">
          <button data-act="minus" title="One night fewer">−</button>
          <span class="n-val">${stop.nights} night${stop.nights === 1 ? "" : "s"}</span>
          <button data-act="plus" title="One night more">+</button>
        </span>
        <label class="arriveby" title="Deadline: warn me if the route arrives later than this">
          by <input type="date" data-act="arriveby" value="${stop.arriveBy ?? ""}" />
        </label>
        <span class="stop-actions">
          <button class="icon-btn" data-act="explore" title="Hostels, food & things to do">🔍</button>
          <button class="icon-btn danger" data-act="remove" title="Remove stop">✕</button>
        </span>
      </div>
      ${badges.length ? `<div class="stop-badges">${badges.join("")}</div>` : ""}
    `;

    card.addEventListener("click", (e) => {
      if (e.target.closest("button") || e.target.closest("input") || e.target.closest("select")) return;
      selectedStopId = stop.id;
      renderStops();
      panToStop(stop);
    });
    card.querySelector('[data-act="minus"]').addEventListener("click", () => {
      if (stop.nights > 0) { stop.nights--; saveTrip(); renderAll(); }
    });
    card.querySelector('[data-act="plus"]').addEventListener("click", () => {
      stop.nights++; saveTrip(); renderAll();
    });
    card.querySelector('[data-act="up"]').addEventListener("click", () => moveStop(index, index - 1));
    card.querySelector('[data-act="down"]').addEventListener("click", () => moveStop(index, index + 2));
    card.querySelector('[data-act="arriveby"]').addEventListener("change", (e) => {
      stop.arriveBy = e.target.value || null; saveTrip(); renderAll();
    });
    card.querySelector('[data-act="remove"]').addEventListener("click", () => {
      const idx = state.stops.findIndex((s) => s.id === stop.id);
      if (idx === -1) return;
      state.stops.splice(idx, 1);
      saveTrip(); renderAll(true);
      toast(`Removed ${stop.name}`, {
        label: "Undo",
        fn: () => {
          state.stops.splice(Math.min(idx, state.stops.length), 0, stop);
          saveTrip(); renderAll(true);
        },
      });
    });
    card.querySelector('[data-act="explore"]').addEventListener("click", () => openExplore(stop.id));

    wrap.appendChild(card);

    if (leg) {
      const next = entries[index + 1].stop;
      const book = legBookingLink(stop, next, leg.mode);
      const modeOption = (m) => {
        const o = leg.options[m];
        if (!o) return "";
        const tags = [];
        if (leg.cheapest.mode === m) tags.push("cheapest");
        if (leg.fastest.mode === m) tags.push("fastest");
        return `<option value="${m}" ${stop.legMode === m ? "selected" : ""}>` +
          `${MODE_ICON[m]} ${MODE_META[m].label} · ${hoursLabel(o.hours)} · ~€${Math.round(o.cost)}` +
          `${tags.length ? " · " + tags.join(" + ") : ""}</option>`;
      };
      const legEl = document.createElement("div");
      legEl.className = "leg";
      legEl.innerHTML = `
        <span class="leg-line"></span>
        <div class="leg-body">
          <div class="leg-top">
            <span class="leg-mode">${MODE_ICON[leg.mode] ?? "🚆"}</span>
            <span class="leg-info"><b>${hoursLabel(leg.hours)}</b> · ${Math.round(leg.km)} km · ~€${Math.round(leg.cost)}
              ${leg.hours >= 8.5 ? ' <span class="leg-warn">long day</span>' : ""}
              · <a href="${book.url}" target="_blank" rel="noopener">${book.label} ↗</a>
            </span>
          </div>
          <select class="leg-select" title="Transport mode for this leg">
            <option value="">Auto · ${MODE_META[leg.recommended.mode].label} (recommended)</option>
            ${modeOption("train")}${modeOption("bus")}${modeOption("flight")}
          </select>
        </div>`;
      if (leg.note) legEl.title = leg.note;
      legEl.querySelector(".leg-select").addEventListener("change", (e) => {
        stop.legMode = e.target.value || null;
        saveTrip();
        renderAll();
      });
      wrap.appendChild(legEl);
    }
  });

  if (!entries.length) {
    wrap.innerHTML = `<div class="search-hint">No stops yet — search above to add your first destination.</div>`;
  }
}

function renderNightsBudget() {
  const { allocated, available } = computeSchedule();
  const fill = $("#nights-fill"), label = $("#nights-label");
  const pct = available > 0 ? Math.min(100, (allocated / available) * 100) : 0;
  fill.style.width = pct + "%";
  fill.classList.toggle("over", allocated > available && available > 0);
  label.classList.toggle("over", allocated > available && available > 0);
  label.textContent = `${allocated} / ${available} nights`;
}

function renderStats() {
  const { entries } = computeSchedule();
  let km = 0, hours = 0, cost = 0;
  entries.forEach((e) => { if (e.leg) { km += e.leg.km; hours += e.leg.hours; cost += e.leg.cost; } });
  $("#trip-stats").innerHTML = entries.length
    ? `<span><b>${entries.length}</b> stops</span>
       <span><b>${Math.round(km).toLocaleString()}</b> km</span>
       <span><b>${hoursLabel(hours)}</b> in transit</span>
       <span title="Rough budget fares booked ahead — bags and city transit not included"><b>~€${Math.round(cost)}</b> transport</span>`
    : "";
}

/* ---------------- itinerary view ---------------- */

function renderItinerary() {
  const { entries, warnings } = computeSchedule();
  const el = $("#itinerary");
  if (!entries.length) { el.innerHTML = ""; return; }

  const first = entries[0].stop, last = entries[entries.length - 1].stop;
  const start = parseDate(state.startDate), end = parseDate(state.endDate);

  let html = `
    <header class="itin-header">
      <h2>${esc(first.name)} → ${esc(last.name)}</h2>
      <p>${fmtLong(start)} – ${fmtLong(end)}, ${start && end ? daysBetween(start, end) : "?"} nights · ${entries.length} stops</p>
    </header>`;

  if (warnings.length) {
    html += `<div class="itin-warnings">` + warnings.map((w) =>
      `<div class="itin-warning ${w.level}"><span>${w.level === "bad" ? "⛔" : "⚠️"}</span><span>${esc(w.text)}</span></div>`
    ).join("") + `</div>`;
  }

  entries.forEach(({ stop, arrival, departure, leg, index }) => {
    const endpoint = index === 0 || index === entries.length - 1;
    const dates = arrival
      ? (stop.nights ? `${fmtLong(arrival)} → ${fmtLong(departure)}` : fmtLong(arrival))
      : "";
    const gmaps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(stop.name)}`;
    const hostelworld = `https://www.hostelworld.com/search?search_keywords=${encodeURIComponent(stop.name + (stop.country ? ", " + stop.country : ""))}`;

    html += `
      <div class="itin-stop${endpoint ? " endpoint" : ""}">
        <div class="itin-rail">
          <div class="itin-dot">${index + 1}</div>
          ${index < entries.length - 1 ? '<div class="itin-rail-line"></div>' : ""}
        </div>
        <div style="flex:1; min-width:0;">
          <div class="itin-card">
            <div class="itin-card-head">
              <h3>${esc(stop.name)}</h3>
              <span class="itin-dates">${dates}</span>
              <span class="itin-nights">${stop.nights} night${stop.nights === 1 ? "" : "s"}</span>
            </div>
            ${stop.note ? `<p class="itin-note">${esc(stop.note)}</p>` : ""}
            <div class="itin-card-actions no-print">
              <button class="chip-link" onclick="WF.openExplore('${stop.id}')">🔍 Explore area</button>
              <a class="chip-link" href="${hostelworld}" target="_blank" rel="noopener">🛏 Hostelworld ↗</a>
              <a class="chip-link" href="${gmaps}" target="_blank" rel="noopener">📍 Google Maps ↗</a>
            </div>
          </div>
          ${leg ? (() => {
            const next = entries[index + 1].stop;
            const book = legBookingLink(stop, next, leg.mode);
            const alts = ["train", "bus", "flight"]
              .filter((m) => leg.options[m] && m !== leg.mode)
              .map((m) => {
                const o = leg.options[m];
                const tags = [];
                if (leg.cheapest.mode === m) tags.push("cheapest");
                if (leg.fastest.mode === m) tags.push("fastest");
                return `${MODE_ICON[m]} ${hoursLabel(o.hours)} · ~€${Math.round(o.cost)}${tags.length ? " (" + tags.join(", ") + ")" : ""}`;
              }).join(" · ");
            return `<div class="itin-leg">${MODE_ICON[leg.mode] ?? "🚆"}
              <span><b>${hoursLabel(leg.hours)}</b> · ${Math.round(leg.km)} km · ~€${Math.round(leg.cost)} to ${esc(next.name)}${leg.note ? ` — ${esc(leg.note)}` : ""}
              · <a href="${book.url}" target="_blank" rel="noopener">${book.label} ↗</a>
              ${alts ? `<span class="itin-alt">Other options: ${alts}</span>` : ""}</span></div>`;
          })() : ""}
        </div>
      </div>`;
  });

  el.innerHTML = html;
}

/* ---------------- explore drawer (Overpass POIs) ---------------- */

const POI_QUERIES = {
  hostels: (lat, lon) => `[out:json][timeout:25];
    nwr["tourism"="hostel"](around:4000,${lat},${lon});
    out center tags 40;`,
  food: (lat, lon) => `[out:json][timeout:25];
    nwr["amenity"~"^(restaurant|cafe|bar|pub)$"]["name"](around:1700,${lat},${lon});
    out center tags 80;`,
  activities: (lat, lon) => `[out:json][timeout:25];
    (
      nwr["tourism"~"^(attraction|museum|gallery|viewpoint|zoo|aquarium|theme_park)$"]["name"](around:4500,${lat},${lon});
      nwr["historic"~"^(castle|palace|monument|fort|city_gate|cathedral)$"]["name"](around:4500,${lat},${lon});
    );
    out center tags 80;`,
};

const POI_ICON = {
  hostel: "🛏", restaurant: "🍽️", cafe: "☕", bar: "🍸", pub: "🍺",
  attraction: "🎟️", museum: "🏛️", gallery: "🖼️", viewpoint: "🌄",
  zoo: "🦁", aquarium: "🐠", theme_park: "🎢", castle: "🏰", palace: "🏰",
  monument: "🗿", fort: "🏯", city_gate: "🚪", cathedral: "⛪",
};

function poiCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch (e) { return {}; }
}

function poiCacheGet(key) {
  const entry = poiCache()[key];
  if (entry && Date.now() - entry.t < POI_TTL_MS) return entry.data;
  return null;
}

function poiCacheSet(key, data) {
  const cache = poiCache();
  cache[key] = { t: Date.now(), data };
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); }
  catch (e) { try { localStorage.removeItem(CACHE_KEY); } catch (e2) {} }
}

async function fetchOverpass(query) {
  let lastErr;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        body: "data=" + encodeURIComponent(query),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

function parsePois(json, center) {
  const seen = new Set();
  const pois = [];
  for (const el of json.elements ?? []) {
    const tags = el.tags ?? {};
    const name = tags.name;
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (lat == null) continue;
    const kind = tags.tourism ?? tags.amenity ?? tags.historic ?? "place";
    pois.push({
      name, lat, lon, kind,
      cuisine: tags.cuisine ? tags.cuisine.split(";")[0].replace(/_/g, " ") : null,
      website: tags.website ?? tags["contact:website"] ?? null,
      wiki: !!(tags.wikipedia || tags.wikidata),
      km: haversineKm(center, { lat, lon }),
    });
  }
  pois.sort((a, b) => (a.wiki === b.wiki ? a.km - b.km : a.wiki ? -1 : 1));
  return pois.slice(0, 25);
}

function openExplore(stopId) {
  const stop = state.stops.find((s) => s.id === stopId);
  if (!stop) return;
  exploreStopId = stopId;
  $("#explore").classList.remove("hidden");
  $("#explore-title").textContent = stop.name;
  const { entries } = computeSchedule();
  const entry = entries.find((e) => e.stop.id === stopId);
  $("#explore-sub").textContent = entry?.arrival
    ? `${fmtLong(entry.arrival)}${stop.nights ? " – " + fmtLong(entry.departure) : ""} · ${stop.nights} night${stop.nights === 1 ? "" : "s"}`
    : "";

  const q = encodeURIComponent(stop.name + (stop.country ? ", " + stop.country : ""));
  $("#explore-links").innerHTML = `
    <a class="chip-link" href="https://www.hostelworld.com/search?search_keywords=${q}" target="_blank" rel="noopener">🛏 Hostelworld ↗</a>
    <a class="chip-link" href="https://www.booking.com/searchresults.html?ss=${q}&nflt=ht_id%3D203" target="_blank" rel="noopener">🏨 Booking ↗</a>
    <a class="chip-link" href="https://www.google.com/maps/search/?api=1&query=${q}" target="_blank" rel="noopener">📍 Maps ↗</a>`;

  setExploreTab(exploreTab || "hostels");
}

function closeExplore() {
  exploreStopId = null;
  $("#explore").classList.add("hidden");
}

function setExploreTab(tab) {
  exploreTab = tab;
  document.querySelectorAll(".explore-tab").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === tab));
  loadExplorePois();
}

async function loadExplorePois() {
  const stop = state.stops.find((s) => s.id === exploreStopId);
  if (!stop) return;
  const tab = exploreTab;
  const body = $("#explore-body");
  const cacheKey = `${stop.lat.toFixed(3)},${stop.lon.toFixed(3)}:${tab}`;

  let pois = poiCacheGet(cacheKey);
  if (!pois) {
    body.innerHTML = `<div class="skeleton"></div>`.repeat(6);
    try {
      const json = await fetchOverpass(POI_QUERIES[tab](stop.lat, stop.lon));
      if (exploreStopId !== stop.id || exploreTab !== tab) return; // user moved on
      pois = parsePois(json, stop);
      poiCacheSet(cacheKey, pois);
    } catch (e) {
      if (exploreStopId !== stop.id || exploreTab !== tab) return;
      body.innerHTML = `<div class="explore-error">Couldn't reach OpenStreetMap right now.<br/>
        <button class="btn btn-ghost btn-sm" style="margin-top:10px" onclick="WF.retryExplore()">Try again</button></div>`;
      return;
    }
  }

  if (!pois.length) {
    body.innerHTML = `<div class="explore-empty">Nothing tagged nearby on OpenStreetMap.<br/>Try the Hostelworld / Maps links above.</div>`;
    return;
  }

  body.innerHTML = pois.map((p) => {
    const walk = Math.round(p.km * 12.5);
    const meta = [
      p.cuisine ? p.cuisine : p.kind.replace(/_/g, " "),
      p.km < 10 ? `${p.km.toFixed(1)} km from center${walk <= 45 ? ` (~${walk} min walk)` : ""}` : null,
    ].filter(Boolean).join(" · ");
    const gmaps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name)}%20%40${p.lat},${p.lon}`;
    return `
      <div class="poi">
        <div class="poi-icon">${POI_ICON[p.kind] ?? "📍"}</div>
        <div class="poi-main">
          <div class="poi-name">${esc(p.name)}</div>
          <div class="poi-meta">${esc(meta)}</div>
          <div class="poi-links">
            <a href="${gmaps}" target="_blank" rel="noopener">Maps ↗</a>
            ${p.website ? `<a href="${esc(p.website)}" target="_blank" rel="noopener">Website ↗</a>` : ""}
          </div>
        </div>
      </div>`;
  }).join("");
}

/* ---------------- place search (Nominatim) ---------------- */

let searchTimer = null;

async function runSearch(q) {
  const box = $("#search-results");
  box.classList.remove("hidden");
  box.innerHTML = `<div class="search-hint">Searching…</div>`;
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=en&addressdetails=1&q=${encodeURIComponent(q)}`;
    const res = await fetch(url);
    const results = await res.json();
    if ($("#place-search").value.trim() !== q) return;
    if (!results.length) {
      box.innerHTML = `<div class="search-hint">No places found for “${esc(q)}”.</div>`;
      return;
    }
    box.innerHTML = "";
    searchHl = -1;
    results.forEach((r) => {
      const name = r.name || r.display_name.split(",")[0];
      const country = r.address?.country ?? "";
      const detail = r.display_name.split(",").slice(1, 3).join(",").trim();
      const btn = document.createElement("button");
      btn.className = "search-result";
      btn.innerHTML = `<div class="sr-name">${esc(name)}</div><div class="sr-detail">${esc(detail || country)}</div>`;
      btn.addEventListener("click", () => {
        addStop({ name, country, lat: parseFloat(r.lat), lon: parseFloat(r.lon) });
        $("#place-search").value = "";
        box.classList.add("hidden");
      });
      box.appendChild(btn);
    });
  } catch (e) {
    box.innerHTML = `<div class="search-hint">Search failed — check your connection.</div>`;
  }
}

function addStop({ name, country, lat, lon }) {
  const stop = { id: uid(), name, country, lat, lon, nights: 2, arriveBy: null, note: "" };
  // keep the final stop as the trip's end point
  if (state.stops.length >= 2) state.stops.splice(state.stops.length - 1, 0, stop);
  else state.stops.push(stop);
  saveTrip();
  renderAll(true);
  toast(`Added ${name} (2 nights) — drag or ▲▼ to reorder, or hit Optimize`);
}

/* ---------------- import / export / reset ---------------- */

function exportTrip() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "wayfarer-trip.json";
  a.click();
  URL.revokeObjectURL(a.href);
  toast("Trip exported");
}

function importTrip(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const t = JSON.parse(reader.result);
      if (!t || !Array.isArray(t.stops)) throw new Error("bad format");
      state = t;
      saveTrip();
      renderAll(true);
      toast("Trip imported");
    } catch (e) { toast("Couldn't read that file — is it a Wayfarer export?"); }
  };
  reader.readAsText(file);
}

function resetTrip() {
  if (!confirm("Reset the trip to its starting state? Your current changes will be lost.")) return;
  state = seedTrip();
  saveTrip();
  renderAll(true);
  toast("Trip reset");
}

/* ---------------- render all + init ---------------- */

function renderAll(fit = false) {
  $("#trip-start").value = state.startDate ?? "";
  $("#trip-end").value = state.endDate ?? "";
  renderStops();
  renderNightsBudget();
  renderStats();
  renderMap(fit);
  renderItinerary();
}

function clearDropMarks() {
  document.querySelectorAll(".drag-over-top, .drag-over-bottom")
    .forEach((el) => el.classList.remove("drag-over-top", "drag-over-bottom"));
}

function endDrag() {
  clearDropMarks();
  document.querySelectorAll(".stop-card.dragging").forEach((el) => el.classList.remove("dragging"));
  document.querySelectorAll('.stop-card[draggable="true"]').forEach((el) => (el.draggable = false));
  dragIndex = null;
  dropTarget = null;
}

function initDragReorder() {
  const list = $("#stops-list");

  // arm dragging only from the handle so inputs/text stay usable
  list.addEventListener("mousedown", (e) => {
    const handle = e.target.closest(".drag-handle");
    if (handle) handle.closest(".stop-card").draggable = true;
  });
  document.addEventListener("mouseup", () => {
    document.querySelectorAll('.stop-card[draggable="true"]').forEach((el) => (el.draggable = false));
  });

  list.addEventListener("dragstart", (e) => {
    const card = e.target.closest(".stop-card");
    if (!card) return;
    dragIndex = Number(card.dataset.index);
    card.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", card.dataset.id); } catch (err) {}
  });

  list.addEventListener("dragover", (e) => {
    if (dragIndex === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    clearDropMarks();
    const card = e.target.closest(".stop-card");
    if (card) {
      // top half = insert before, bottom half = insert after — this is what
      // makes dragging a stop into first/last position work reliably
      const r = card.getBoundingClientRect();
      const before = e.clientY - r.top < r.height / 2;
      dropTarget = { index: Number(card.dataset.index), before };
      card.classList.add(before ? "drag-over-top" : "drag-over-bottom");
    } else {
      const cards = list.querySelectorAll(".stop-card");
      const last = cards[cards.length - 1];
      if (!last) return;
      dropTarget = { index: Number(last.dataset.index), before: false };
      last.classList.add("drag-over-bottom");
    }
  });

  list.addEventListener("drop", (e) => {
    e.preventDefault();
    if (dragIndex !== null && dropTarget) {
      moveStop(dragIndex, dropTarget.index + (dropTarget.before ? 0 : 1));
    }
    endDrag();
  });

  list.addEventListener("dragend", endDrag);
}

function initEvents() {
  $("#trip-start").addEventListener("change", (e) => { state.startDate = e.target.value; saveTrip(); renderAll(); });
  $("#trip-end").addEventListener("change", (e) => { state.endDate = e.target.value; saveTrip(); renderAll(); });

  $("#place-search").addEventListener("input", (e) => {
    const q = e.target.value.trim();
    clearTimeout(searchTimer);
    if (q.length < 2) { $("#search-results").classList.add("hidden"); return; }
    searchTimer = setTimeout(() => runSearch(q), 450);
  });
  $("#place-search").addEventListener("keydown", (e) => {
    const box = $("#search-results");
    const items = [...box.querySelectorAll(".search-result")];
    if (box.classList.contains("hidden") || !items.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      searchHl = e.key === "ArrowDown"
        ? (searchHl + 1) % items.length
        : (searchHl - 1 + items.length) % items.length;
      items.forEach((el, i) => el.classList.toggle("hl", i === searchHl));
      items[searchHl].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      (items[searchHl] ?? items[0]).click();
    } else if (e.key === "Escape") {
      box.classList.add("hidden");
    }
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-wrap")) $("#search-results").classList.add("hidden");
  });

  initDragReorder();

  $("#btn-optimize").addEventListener("click", optimizeRoute);
  $("#btn-balance").addEventListener("click", autoBalanceNights);
  $("#btn-export").addEventListener("click", exportTrip);
  $("#btn-import").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", (e) => {
    if (e.target.files[0]) importTrip(e.target.files[0]);
    e.target.value = "";
  });
  $("#btn-reset").addEventListener("click", resetTrip);

  document.querySelectorAll(".view-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".view-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
      $("#view-" + tab.dataset.view).classList.add("active");
      if (tab.dataset.view === "map" && map) setTimeout(() => map.invalidateSize(), 60);
    });
  });

  $("#btn-print").addEventListener("click", () => {
    window.print();
  });

  $("#explore-close").addEventListener("click", closeExplore);
  document.querySelectorAll(".explore-tab").forEach((tab) =>
    tab.addEventListener("click", () => setExploreTab(tab.dataset.tab)));
}

// exposed for inline handlers (itinerary chips, popup buttons, retry)
window.WF = { openExplore, retryExplore: () => loadExplorePois() };

initMap();
initEvents();
renderAll(true);
