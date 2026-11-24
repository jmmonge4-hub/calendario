# Copia de solo lectura de TUS guardias, permisos y festivos desde el Portal Médicos
# Villarramiel v2 (Firebase propio) a planif.json, que leen la app y calendario.ics.
# Usa una cuenta de servicio con rol de SOLO LECTURA (Cloud Datastore Viewer) guardada
# en el secreto PORTAL_FIREBASE_SA. No escribe nada en el portal.
# Sin el secreto, o si falla la lectura, deja planif.json como estaba.
import datetime, json, os, sys, unicodedata

MEDICO = "juan manuel"
SALIDA = "planif.json"

def aviso(msg):
    print(f"::warning::{msg} Se mantiene el planif.json anterior.")
    if os.environ.get("GITHUB_ENV"):
        with open(os.environ["GITHUB_ENV"], "a") as f: f.write("ICS_ANTIGUO=1\n")
    sys.exit(0)

clave = os.environ.get("PORTAL_FIREBASE_SA", "").strip()
if not clave: aviso("Falta el secreto PORTAL_FIREBASE_SA (cuenta de servicio del portal).")

import requests
from google.oauth2 import service_account
from google.auth.transport.requests import Request

try:
    info = json.loads(clave)
    cred = service_account.Credentials.from_service_account_info(info, scopes=["https://www.googleapis.com/auth/datastore"])
    cred.refresh(Request())
except Exception as e:
    aviso(f"La cuenta de servicio no vale ({type(e).__name__}).")
BASE = f"https://firestore.googleapis.com/v1/projects/{info['project_id']}/databases/(default)/documents"
S = requests.Session(); S.headers["Authorization"] = f"Bearer {cred.token}"

def valor(v):
    if "mapValue" in v: return {k: valor(x) for k, x in v["mapValue"].get("fields", {}).items()}
    if "arrayValue" in v: return [valor(x) for x in v["arrayValue"].get("values", [])]
    if "integerValue" in v: return int(v["integerValue"])
    for t in ("stringValue", "doubleValue", "booleanValue", "timestampValue"):
        if t in v: return v[t]
    return None

def doc(ruta):
    r = S.get(f"{BASE}/{ruta}", timeout=30)
    if r.status_code == 404: return None
    if r.status_code != 200: aviso(f"No se pudo leer {ruta} del portal (HTTP {r.status_code}).")
    return {k: valor(v) for k, v in r.json().get("fields", {}).items()}

def coleccion(nombre):
    out, token = {}, None
    while True:
        r = S.get(f"{BASE}/{nombre}", params={"pageSize": 300, **({"pageToken": token} if token else {})}, timeout=30)
        if r.status_code != 200: aviso(f"No se pudo leer {nombre} del portal (HTTP {r.status_code}).")
        j = r.json()
        for d in j.get("documents", []):
            out[d["name"].rsplit("/", 1)[1]] = {k: valor(v) for k, v in d.get("fields", {}).items()}
        token = j.get("nextPageToken")
        if not token: return out

def sin_tildes(s):
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn").lower()

lista = (doc("config/medicos_guardias") or {}).get("lista") or []
yo = next((m for m in lista if MEDICO in sin_tildes(str(m.get("nombre", "")))), None)
if not yo: aviso(f"No encuentro a '{MEDICO}' en la lista de médicos de guardia del portal.")

def clave_app(k):  # "2027-01" (portal) -> "2027-0" (app: mes empezando en 0)
    a, m = k.split("-"); return f"{int(a)}-{int(m) - 1}"

g, p = {}, {}
for k, mes in coleccion("guardias").items():
    try: ka = clave_app(k)
    except ValueError: continue
    ds = sorted(int(d) for d, quien in (mes.get("asign") or {}).items() if quien == yo["id"])
    if ds: g[ka] = ds
    perm = sorted({int(d) for d in ((mes.get("permisos") or {}).get(yo["id"]) or [])})
    if perm: p[ka] = perm

# Festivos: los guardados en el portal (config/festivos) o, si no, los de por defecto
# (mismo cálculo que src/lib/festivos.js del portal)
def pascua(a):
    b, c = divmod(a, 100); h = (19 * (a % 19) + b - b // 4 - (b - (b + 8) // 25 + 1) // 3 + 15) % 30
    l = (32 + 2 * (b % 4) + 2 * (c // 4) - h - c % 4) % 7; m = (a % 19 + 11 * h + 22 * l) // 451
    return datetime.date(a, (h + l - 7 * m + 114) // 31, (h + l - 7 * m + 114) % 31 + 1)
def por_defecto(a):
    ps = pascua(a); d = datetime.date
    fijos = [(1, 1), (1, 6), (4, 23), (5, 1), (8, 15), (8, 24), (9, 21), (10, 12), (11, 1), (12, 6), (12, 8), (12, 25)]
    return [d(a, m, x) for m, x in fijos] + [ps - datetime.timedelta(3), ps - datetime.timedelta(2)]
guardados = (doc("config/festivos") or {}).get("anios") or {}
hoy = datetime.date.today().year
anios = {int(k.split("-")[0]) for k in g} | {int(k.split("-")[0]) for k in p} | set(range(hoy - 1, hoy + 3))
f = {}
for a in sorted(anios):
    if str(a) in guardados:
        fechas = [datetime.date.fromisoformat(x["f"]) for x in guardados[str(a)] if isinstance(x, dict) and x.get("f")]
    else:
        fechas = por_defecto(a)
    for x in fechas: f.setdefault(f"{x.year}-{x.month - 1}", []).append(x.day)
f = {k: sorted(set(v)) for k, v in f.items()}

orden = lambda dd: dict(sorted(dd.items(), key=lambda kv: tuple(map(int, kv[0].split("-")))))
datos = {"name": yo.get("nombre", ""), "fuente": "portal", "g": orden(g), "p": orden(p), "f": orden(f)}
nuevo = json.dumps(datos, ensure_ascii=False, separators=(",", ":"))
try: viejo = json.dumps({k: v for k, v in json.load(open(SALIDA)).items() if k != "at"}, ensure_ascii=False, separators=(",", ":"))
except Exception: viejo = None
if nuevo == viejo:
    print("planif.json sin cambios"); sys.exit(0)
datos["at"] = int(datetime.datetime.now().timestamp() * 1000)
with open(SALIDA, "w", encoding="utf-8") as fh: json.dump(datos, fh, ensure_ascii=False, separators=(",", ":"))
print(f"planif.json: {sum(map(len, g.values()))} guardias, {sum(map(len, p.values()))} días de permiso, meses {min(g, default='-')}..{max(g, default='-')}")
