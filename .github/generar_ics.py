# Genera calendario.ics (para suscribirse desde Google Calendar) a partir de:
#  - la planificación (villarramiel/turnos_guardias): guardias, permisos (como vacaciones) y festivos de Juan Manuel
#  - tus colores y notas (colección calendario_personal)
# Solo lee de Firestore; no escribe nada allí.
import json, re, urllib.request, datetime

PROYECTO = "padel-gestor"
CLAVE = "AIzaSyBLc4g0YhCPMM8x67wA_CttGu-FkqMKg0U"
MEDICO = "juan manuel"
BASE = f"https://firestore.googleapis.com/v1/projects/{PROYECTO}/databases/(default)/documents"
NOMBRES = {"guardia": "Guardia", "consulta": "Consulta", "vacaciones": "Vacaciones", "ocio": "Ocio",
           "curso": "Curso/Formación", "festivo": "Festivo", "otro": "Otro"}

def get(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.load(r)

def valor(v):
    if "mapValue" in v: return {k: valor(x) for k, x in v["mapValue"].get("fields", {}).items()}
    if "arrayValue" in v: return [valor(x) for x in v["arrayValue"].get("values", [])]
    if "integerValue" in v: return int(v["integerValue"])
    for t in ("stringValue", "doubleValue", "booleanValue"):
        if t in v: return v[t]
    return None

def sin_tildes(s):
    import unicodedata
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn").lower()

# Planificación -> {"2026-10-05": ["guardia", ...]}
planif = {k: valor(v) for k, v in get(f"{BASE}/villarramiel/turnos_guardias?key={CLAVE}")["fields"].items()}
yo = next(i for i, w in enumerate(planif.get("trabajadores", [])) if MEDICO in sin_tildes(str(w)))
ext = {}
def add(clave_mes, dia, cat):
    y, m = map(int, clave_mes.split("-"))
    try: k = datetime.date(y, m + 1, int(dia)).isoformat()
    except ValueError: return
    ext.setdefault(k, [])
    if cat not in ext[k]: ext[k].append(cat)
for km, dias in (planif.get("asignaciones") or {}).items():
    for d, w in (dias or {}).items():
        if int(w) == yo: add(km, d, "guardia")
for km, porMedico in (planif.get("permisos") or {}).items():
    for d in (porMedico or {}).get(str(yo)) or []: add(km, d, "vacaciones")
for km, dias in (planif.get("festivos") or {}).items():
    for d in dias or []: add(km, d, "festivo")

# Tus días
dias = {}
url = f"{BASE}/calendario_personal?key={CLAVE}&pageSize=300"
token = None
while True:
    r = get(url + (f"&pageToken={token}" if token else ""))
    for doc in r.get("documents", []):
        dias.update(valor(doc["fields"].get("days", {"mapValue": {}})) or {})
    token = r.get("nextPageToken")
    if not token: break

def esc(s): return s.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")
def plegar(linea):  # líneas de máx. 75 bytes (formato iCalendar)
    out, b = [], linea.encode()
    while len(b) > 75:
        corte = 75
        while (b[corte] & 0xC0) == 0x80: corte -= 1
        out.append(b[:corte].decode()); b = b" " + b[corte:]
    out.append(b.decode()); return "\r\n".join(out)

ahora = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
lineas = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Mi Calendario//ES", "CALSCALE:GREGORIAN",
          "X-WR-CALNAME:Mi Calendario", "X-WR-TIMEZONE:Europe/Madrid", "REFRESH-INTERVAL;VALUE=DURATION:PT6H"]
eventos = 0
for k in sorted(set(dias) | set(ext)):
    info = dias.get(k) or {}
    mias = [c for c in (info.get("c") or []) if c in NOMBRES]
    ocultas = info.get("h") or []
    cats = [c for c in ext.get(k, []) if c not in ocultas and c not in mias] + mias
    nota = (info.get("n") or "").strip()
    fecha = datetime.date.fromisoformat(k)
    items = [(c, NOMBRES[c] + (f" · {nota}" if nota and i == 0 else "")) for i, c in enumerate(cats)] or ([("nota", nota)] if nota else [])
    for c, titulo in items:
        lineas += ["BEGIN:VEVENT", f"UID:{k}-{c}@mi-calendario", f"DTSTAMP:{ahora}",
                   f"DTSTART;VALUE=DATE:{fecha:%Y%m%d}", f"DTEND;VALUE=DATE:{fecha + datetime.timedelta(days=1):%Y%m%d}",
                   plegar(f"SUMMARY:{esc(titulo)}"), "TRANSP:TRANSPARENT"]
        if nota: lineas.append(plegar(f"DESCRIPTION:{esc(nota)}"))
        lineas.append("END:VEVENT"); eventos += 1
lineas.append("END:VCALENDAR")
with open("calendario.ics", "w", encoding="utf-8", newline="") as f:
    f.write("\r\n".join(lineas) + "\r\n")
print(f"calendario.ics: {eventos} eventos")
