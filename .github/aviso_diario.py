# Manda al móvil (app ntfy) lo que tienes hoy: guardias, turnos y notas.
# Lee calendario.ics recién generado; no escribe nada en Firestore.
# Con la ejecución programada, el aviso queda citado para las 8:00 (hora de Madrid);
# lanzado a mano, llega en el momento (sirve de prueba).
import datetime, json, os, sys, time, urllib.request
from zoneinfo import ZoneInfo

TEMA = os.environ["NTFY_TOPIC"]
APP = "https://jmmonge4-hub.github.io/calendario/"
MADRID = ZoneInfo("Europe/Madrid")
EMOJI = {"Guardia": "🩺", "Consulta": "🏥", "Vacaciones": "🏖️", "Ocio": "🎉",
         "Curso/Formación": "📚", "Festivo": "🎈", "Otro": "📌"}

def eventos(ruta):
    """{fecha: [títulos]} a partir del .ics (desplegando líneas y quitando escapes)."""
    texto = open(ruta, encoding="utf-8").read().replace("\r\n ", "").replace("\r\n", "\n")
    out, fecha, titulo = {}, None, None
    for l in texto.split("\n"):
        if l == "BEGIN:VEVENT": fecha = titulo = None
        elif l.startswith("DTSTART"): fecha = l.split(":", 1)[1][:8]
        elif l.startswith("SUMMARY:"):
            titulo = l[8:].replace("\\n", "\n").replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\")
        elif l == "END:VEVENT" and fecha and titulo: out.setdefault(fecha, []).append(titulo)
    return out

ahora = datetime.datetime.now(MADRID)
hoy = ahora.date()
lista = eventos("calendario.ics").get(f"{hoy:%Y%m%d}", [])
lineas = []
for t in lista:
    cat = t.split(" · ", 1)[0]
    lineas.append(f"{EMOJI.get(cat, '📝')} {t}")
DIAS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]
MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto",
         "septiembre", "octubre", "noviembre", "diciembre"]
titulo = f"Hoy, {DIAS[hoy.weekday()]} {hoy.day} de {MESES[hoy.month - 1]}"
cuerpo = "\n".join(lineas) or "Nada apuntado. ¡Día libre!"

datos = {"topic": TEMA, "title": titulo, "message": cuerpo, "click": APP, "tags": ["calendar"]}
# Programado: se entrega a las 8:00 de Madrid (si aún no han pasado)
if os.environ.get("EVENTO") == "schedule":
    ocho = datetime.datetime.combine(hoy, datetime.time(8, 0), MADRID)
    if ocho.timestamp() > time.time() + 30:
        datos["delay"] = str(int(ocho.timestamp()))
if os.environ.get("PRUEBA"):
    print(json.dumps(datos, ensure_ascii=False, indent=1)); sys.exit()
req = urllib.request.Request("https://ntfy.sh/", data=json.dumps(datos).encode(),
                             headers={"Content-Type": "application/json"}, method="POST")
with urllib.request.urlopen(req, timeout=30) as r:
    print(r.status, titulo, "|", cuerpo.replace("\n", " / "), "| a las 8:00" if "delay" in datos else "| ya")
