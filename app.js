// Calendario personal: pinta días por categoría, sincroniza con Firestore
// y muestra las guardias leídas de la app de trabajo.

const CATEGORIES = [
  { id: "guardia", code: "G",    name: "Guardia",          color: "#cf222e" },
  { id: "consulta", code: "C",   name: "Consulta",         color: "#1f6feb" },
  { id: "vacaciones", code: "V", name: "Vacaciones",       color: "#2da44e" },
  { id: "ocio", code: "OC",    name: "Ocio",  color: "#bf8700" },
  { id: "curso", code: "CU",      name: "Curso/Formación",  color: "#8250df" },
  { id: "festivo", code: "F",    name: "Festivo",          color: "#f2cc60", light: true },
  { id: "otro", code: "O",       name: "Otro",             color: "#57606a" },
];
const CAT = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));
const BRUSH_ERASE = "_borrar";

const cfg = window.CAL_CONFIG || {};
const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, "0");
const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const monthKey = (y, m) => `${y}-${pad(m + 1)}`;

const now = new Date();
let year = now.getFullYear(), month = now.getMonth();
// localStorage puede fallar (modo privado, almacenamiento bloqueado)
const store = {
  get(k, def) { try { return localStorage.getItem(k) ?? def; } catch { return def; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
let brush = store.get("cal-brush", "consulta");

// ---------- Almacenamiento local (siempre, también como caché sin red) ----------
let days = (() => { try { return JSON.parse(store.get("cal-days", "{}")); } catch { return {}; } })(); // { "2026-10-11": {c, n} }
const saveLocal = () => store.set("cal-days", JSON.stringify(days));

// ---------- Firestore (opcional) ----------
let fs = null, db = null, unsubMonth = null;
const pendingMonths = new Set();

// Punto de estado junto al mes: verde sincronizado, ámbar local/sin red, rojo error
function setSync(text) {
  const el = $("sync");
  el.title = text; el.setAttribute("aria-label", text);
  el.className = "sync " + (/Error|No se pud/.test(text) ? "err" : text === "Sincronizado" ? "ok" : "warn");
}

async function initFirebase() {
  if (!cfg.firebaseConfig) {
    const show = () => setSync(navigator.onLine ? "Guardado en este dispositivo" : "Sin conexión · guardado en este dispositivo");
    show(); addEventListener("online", show); addEventListener("offline", show);
    return;
  }
  setSync("Conectando…");
  try {
    const V = "10.12.2";
    const appMod = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`);
    fs = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`);
    const app = appMod.initializeApp(cfg.firebaseConfig);
    db = fs.initializeFirestore(app, { localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }) });
    if (cfg.auth && cfg.auth !== "none") {
      const au = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`);
      const auth = au.getAuth(app);
      await new Promise(res => { const off = au.onAuthStateChanged(auth, u => { off(); res(u); }); })
        .then(async u => {
          if (u) return;
          if (cfg.auth === "anonymous") await au.signInAnonymously(auth);
          else await au.signInWithPopup(auth, new au.GoogleAuthProvider());
        });
    }
    // Junta lo guardado en local con lo de la nube (por día; gana lo local) y sube solo lo que falte
    const localMonths = new Set(Object.keys(days).map(k => k.slice(0, 7)));
    for (const mk of localMonths) {
      const snap = await fs.getDoc(fs.doc(db, cfg.dataCollection || "calendario_personal", mk));
      const remote = snap.exists() ? (snap.data().days || {}) : {};
      const differs = Object.keys(days).some(k => k.startsWith(mk) && JSON.stringify(days[k]) !== JSON.stringify(remote[k]));
      for (const [k, v] of Object.entries(remote)) if (!(k in days)) days[k] = v;
      if (differs) pendingMonths.add(mk);
    }
    saveLocal(); render();
    flush();
    setSync("Sincronizado");
    watchMonth();
  } catch (e) {
    console.error(e);
    setSync("Sin conexión con Firestore (se guarda en local)");
  }
}

function watchMonth() {
  if (!db) return;
  unsubMonth?.();
  const mk = monthKey(year, month);
  unsubMonth = fs.onSnapshot(fs.doc(db, cfg.dataCollection || "calendario_personal", mk), snap => {
    const remote = snap.exists() ? (snap.data().days || {}) : {};
    if (pendingMonths.has(mk)) return; // hay cambios locales sin subir
    for (const k of Object.keys(days)) if (k.startsWith(mk) && !remote[k]) delete days[k];
    Object.assign(days, remote);
    saveLocal(); render();
    setSync(snap.metadata.hasPendingWrites ? "Guardando…" : snap.metadata.fromCache ? "Sin red (se sincronizará)" : "Sincronizado");
  }, e => { console.error(e); setSync("Error de permisos en Firestore"); });
}

let flushTimer = null;
function flush() {
  if (!db) return;
  clearTimeout(flushTimer);
  flushTimer = setTimeout(async () => {
    for (const mk of [...pendingMonths]) {
      const monthDays = Object.fromEntries(Object.entries(days).filter(([k]) => k.startsWith(mk)));
      try {
        await fs.setDoc(fs.doc(db, cfg.dataCollection || "calendario_personal", mk), { days: monthDays, updated: Date.now() });
        pendingMonths.delete(mk);
      } catch (e) { console.error(e); setSync("No se pudo guardar en Firestore"); }
    }
  }, 400);
}

// ---------- Planificación de guardias (solo lectura) ----------
// Lee el documento de la herramienta "Control de Turnos" y se queda solo con lo
// de este médico: { g: {"2026-9": [días de guardia]}, p: {...permisos}, f: {...festivos} }.
// Las claves de mes van con el mes empezando en 0, igual que en esa herramienta.
// Se guarda una copia en el dispositivo para verlo sin conexión. Nunca se escribe allí.
let planif = (() => { try { return JSON.parse(store.get("cal-planif", "null")); } catch { return null; } })();
const norm = s => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const hasDay = (arr, d) => Array.isArray(arr) && arr.some(x => Number(x) === d);

function extFor(y, m, d) {
  if (!planif) return [];
  const k = `${y}-${m}`, out = [];
  if (hasDay(planif.g?.[k], d)) out.push("guardia");
  if (hasDay(planif.p?.[k], d)) out.push("vacaciones"); // los permisos se muestran como vacaciones
  if (hasDay(planif.f?.[k], d)) out.push("festivo");
  return out;
}

let fbMods = null;
async function loadFirebase() {
  if (fbMods) return fbMods;
  const V = "10.12.2";
  const [appMod, fsMod] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`),
  ]);
  return (fbMods = { appMod, fsMod });
}

let planifDb = null;
async function loadPlanif() {
  const pc = cfg.planificacion;
  if (!pc) return;
  if (!navigator.onLine) { setPlanifStatus(); return; }
  try {
    const { appMod, fsMod } = await loadFirebase();
    if (!planifDb) planifDb = fsMod.getFirestore(appMod.initializeApp(pc.firebaseConfig, "planificacion"));
    const snap = await fsMod.getDoc(fsMod.doc(planifDb, pc.collection, pc.document));
    if (!snap.exists()) throw new Error("No existe el documento de la planificación");
    const data = snap.data();
    const workers = (data.trabajadores || []).map(w => typeof w === "string" ? w : w?.nombre ?? "");
    const me = workers.findIndex(w => norm(w).includes(norm(pc.worker)));
    if (me < 0) { setSync(`Error: no encuentro a ${pc.worker} en la planificación`); return; }
    const g = {}, p = {}, f = {};
    for (const [k, byDay] of Object.entries(data.asignaciones || {})) {
      const ds = Object.entries(byDay || {}).filter(([, w]) => Number(w) === me).map(([d]) => Number(d));
      if (ds.length) g[k] = ds;
    }
    for (const [k, byWorker] of Object.entries(data.permisos || {})) {
      const ds = byWorker?.[me];
      if (Array.isArray(ds) && ds.length) p[k] = ds.map(Number);
    }
    for (const [k, ds] of Object.entries(data.festivos || {})) if (Array.isArray(ds) && ds.length) f[k] = ds.map(Number);
    planif = { name: workers[me], g, p, f, at: Date.now() };
    store.set("cal-planif", JSON.stringify(planif));
    setPlanifStatus();
    render();
  } catch (e) {
    console.error(e);
    setSync(planif ? "No se pudo actualizar la planificación (uso la última copia)" : "Error: no se pudo leer la planificación");
  }
}
function setPlanifStatus() {
  if (!planif) return;
  const when = new Date(planif.at).toLocaleString("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  if (!cfg.firebaseConfig) setSync(`Guardias de ${planif.name} actualizadas el ${when}${navigator.onLine ? "" : " · sin conexión"}`);
}
addEventListener("online", loadPlanif);
document.addEventListener("visibilitychange", () => { if (!document.hidden) loadPlanif(); });

// ---------- Pintado ----------
const shifts = info => Array.isArray(info.c) ? info.c : info.c ? [info.c] : [];

// Guarda un día y lo sincroniza
function saveDay(key, cur) {
  if (cur.c?.length || cur.n || cur.h?.length) days[key] = cur; else delete days[key];
  saveLocal();
  pendingMonths.add(key.slice(0, 7));
  flush();
  render();
}

// Modo pintar: cada toque pone o quita el turno elegido (hasta 3 por día)
// Lo de la planificación que se ve en un día (menos lo que hayas borrado a mano, en "h")
const keyParts = key => { const [y, m, d] = key.split("-").map(Number); return [y, m - 1, d]; };
const visibleExt = key => extFor(...keyParts(key)).filter(id => !(days[key]?.h || []).includes(id));

function applyBrush(key) {
  const cur = { ...(days[key] || {}) };
  if (brush === BRUSH_ERASE) {
    // La goma quita todos los colores del día (también los de la planificación); la nota se queda
    delete cur.c;
    const ext = extFor(...keyParts(key));
    if (ext.length) cur.h = ext; else delete cur.h;
  } else {
    if (cur.h?.includes(brush)) { cur.h = cur.h.filter(x => x !== brush); if (!cur.h.length) delete cur.h; saveDay(key, cur); return; }
    let list = shifts(cur);
    if (list.includes(brush)) list = list.filter(x => x !== brush);
    else list = [...list, brush].slice(-3);
    if (list.length) cur.c = list; else delete cur.c;
  }
  saveDay(key, cur);
}

// Hoja del día: elegir turnos y escribir nota
const fmtDay = new Intl.DateTimeFormat("es-ES", { weekday: "long", day: "numeric", month: "long" });
let dayKey = null, daySel = [];
function openDay(key) {
  dayKey = key;
  const [y, m, d] = key.split("-").map(Number);
  const cur = days[key] || {};
  daySel = shifts(cur).filter(id => CAT[id]);
  $("dayTitle").textContent = fmtDay.format(new Date(y, m - 1, d));
  $("noteText").value = cur.n || "";
  const ext = visibleExt(key);
  $("dayExt").hidden = !ext.length;
  $("dayExt").textContent = "De la planificación: " + ext.map(id => CAT[id].name).join(", ");
  renderDayCats();
  $("daySheet").hidden = false;
}
function renderDayCats() {
  const box = $("dayCats");
  box.innerHTML = "";
  for (const c of CATEGORIES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = daySel.includes(c.id) ? "on" : "";
    b.innerHTML = `<i style="background:${c.color};color:${c.light ? "#1f2328" : "#fff"}">${c.code}</i><span>${c.name.replace("/", "/<wbr>")}</span>`;
    b.onclick = () => {
      daySel = daySel.includes(c.id) ? daySel.filter(x => x !== c.id) : [...daySel, c.id].slice(-3);
      renderDayCats();
    };
    box.append(b);
  }
}
const closeDay = () => { $("daySheet").hidden = true; dayKey = null; };
$("dayForm").onsubmit = e => {
  e.preventDefault();
  const cur = {};
  if (days[dayKey]?.h) cur.h = days[dayKey].h;
  if (daySel.length) cur.c = daySel;
  const n = $("noteText").value.trim(); if (n) cur.n = n;
  saveDay(dayKey, cur); closeDay();
};
$("dayClear").onclick = () => {
  const ext = extFor(...keyParts(dayKey));
  saveDay(dayKey, ext.length ? { h: ext } : {}); closeDay();
};
$("dayCancel").onclick = closeDay;
$("daySheet").addEventListener("click", e => { if (e.target === $("daySheet")) closeDay(); });

// ---------- Dibujo ----------
// Mes y año son desplegables: al tocarlos se elige directamente
const MESES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
$("selMonth").innerHTML = MESES.map((n, i) => `<option value="${i}">${n}</option>`).join("");
function fillYears() {
  const from = Math.min(2021, year - 1), to = Math.max(now.getFullYear() + 5, year + 1);
  const sel = $("selYear");
  if (sel.dataset.range === `${from}-${to}`) return;
  sel.dataset.range = `${from}-${to}`;
  sel.innerHTML = Array.from({ length: to - from + 1 }, (_, i) => `<option>${from + i}</option>`).join("");
}
$("selMonth").onchange = e => { month = Number(e.target.value); go(0); };
$("selYear").onchange = e => { year = Number(e.target.value); go(0); };

function render() {
  fillYears();
  $("selMonth").value = month; $("selYear").value = year;
  const grid = $("grid");
  grid.innerHTML = "";
  const first = (new Date(year, month, 1).getDay() + 6) % 7; // lunes = 0
  const total = new Date(year, month + 1, 0).getDate();
  const todayKey = iso(now.getFullYear(), now.getMonth(), now.getDate());
  const counts = {};
  let nGuardias = 0;

  for (let i = 0; i < first; i++) grid.append(Object.assign(document.createElement("div"), { className: "cell out" }));
  for (let d = 1; d <= total; d++) {
    const key = iso(year, month, d), info = days[key] || {};
    const dow = (first + d - 1) % 7;
    const el = document.createElement("div");
    el.className = "cell" + (dow >= 5 ? " we" : "") + (key === todayKey ? " today" : "");
    el.dataset.key = key;
    el.innerHTML = `<span class="num">${d}</span>`;
    const mine = shifts(info).filter(id => CAT[id]);
    const ext = visibleExt(key).filter(id => !mine.includes(id));
    const list = [...ext, ...mine].slice(0, 3);
    if (visibleExt(key).includes("guardia")) nGuardias++;
    if (list.length) {
      const box = document.createElement("div");
      box.className = "shifts";
      for (const id of list) {
        const c = CAT[id];
        counts[id] = (counts[id] || 0) + 1;
        const b = document.createElement("span");
        b.className = "shift" + (c.light ? " light" : "") + (ext.includes(id) ? " ext" : "");
        b.style.background = c.color;
        b.innerHTML = `<b>${c.code}</b><span class="lbl">${c.name}</span>`;
        if (ext.includes(id)) b.title = c.name + " (de la planificación)";
        box.append(b);
      }
      el.append(box);
      el.classList.add("painted");
      if (CAT[list[0]].light) el.classList.add("light-top");
    }
    if (info.n) {
      const n = document.createElement("span");
      n.className = "note"; n.textContent = info.n;
      el.classList.add("has-note");
      if (list.length) {
        // Día pintado: la nota va dentro del color, debajo del turno (como en Shifter)
        const last = CAT[list[list.length - 1]], band = el.querySelector(".shift:last-child");
        n.classList.add("in"); if (last.light) n.classList.add("light");
        band.classList.add("with-note");
        band.append(n);
      } else el.append(n);
    }
    el.title = [...list.map(id => CAT[id].name), info.n].filter(Boolean).join(" · ");
    grid.append(el);
  }

  const parts = CATEGORIES.filter(c => counts[c.id])
    .map(c => `<span title="${c.name}"><i style="background:${c.color}"></i>${c.code} <b>${counts[c.id]}</b></span>`);

  $("summary").innerHTML = parts.join("") || "<span>Toca un día para apuntar, o Pintar para marcar varios.</span>";
}

function renderPalette() {
  const p = $("palette");
  p.innerHTML = "";
  $("eraseBtn").classList.toggle("on", brush === BRUSH_ERASE);
  for (const it of CATEGORIES) {
    const b = document.createElement("button");
    b.className = "chip" + (it.id === brush ? " on" : "");
    const bg = it.color ? `background:${it.color};color:${it.light ? "#1f2328" : "#fff"};border-color:transparent` : "";
    b.innerHTML = `<i style="${bg}">${it.code}</i>${it.name.split("/")[0]}`;
    b.onclick = () => { brush = it.id; store.set("cal-brush", brush); renderPalette(); };
    p.append(b);
  }
}

let painting = false;
function setPainting(on) {
  painting = on;
  document.body.classList.toggle("painting", on);
  $("paint").hidden = !on; $("bar").hidden = on;
  if (on) { if (brush !== BRUSH_ERASE && !CAT[brush]) brush = "consulta"; renderPalette(); }
}
$("paintBtn").onclick = () => setPainting(true);
$("paintDone").onclick = () => setPainting(false);
$("eraseBtn").onclick = () => { brush = BRUSH_ERASE; store.set("cal-brush", brush); renderPalette(); };

// ---------- Navegación ----------
function go(dm) {
  const d = new Date(year, month + dm, 1);
  year = d.getFullYear(); month = d.getMonth();
  render(); watchMonth();
}
$("prevMonth").onclick = () => go(-1);
$("nextMonth").onclick = () => go(1);
$("prevYear").onclick = () => go(-12);
$("nextYear").onclick = () => go(12);
$("today").onclick = () => { year = now.getFullYear(); month = now.getMonth(); go(0); };
$("grid").addEventListener("click", e => { const c = e.target.closest(".cell[data-key]"); if (!c) return; painting ? applyBrush(c.dataset.key) : openDay(c.dataset.key); });
document.addEventListener("keydown", e => {
  if (!$("daySheet").hidden) { if (e.key === "Escape") closeDay(); return; }
  if (e.key === "Escape" && painting) setPainting(false);
  if (e.key === "ArrowLeft") go(-1);
  if (e.key === "ArrowRight") go(1);
});
// Deslizar el dedo para cambiar de mes
let sx = null, sy = null;
$("grid").addEventListener("touchstart", e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
$("grid").addEventListener("touchend", e => {
  if (sx === null) return;
  const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
  sx = null;
});

// ---------- Instalación (PWA) ----------
let installEvt = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; $("install").hidden = false; });
$("install").onclick = async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $("install").hidden = true; };
// Actualizaciones: al volver a la app busca versión nueva y, si la hay, recarga sola
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(reg => {
    const check = () => reg.update().catch(() => {});
    document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
    setInterval(check, 30 * 60 * 1000);
  }).catch(console.error);
  let reloaded = false;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloaded) return;
    reloaded = true;
    // No recargar a mitad de una nota
    if ($("daySheet").hidden) location.reload();
  });
}

render();
initFirebase().then(() => { setPlanifStatus(); loadPlanif(); });
