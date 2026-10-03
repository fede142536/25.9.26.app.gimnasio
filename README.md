# App Gimnasio — Entrenador de musculación

App web (HTML/CSS/JS puro, sin backend ni build) para llevar tus rutinas de
musculación, ver tu progreso y recibir sugerencias automáticas de carga.
Todo corre en el navegador; los datos se guardan en `localStorage` de ese
dispositivo (no hay servidor ni cuenta).

## Pestañas

- **Hoy** — elegís el día de tu rutina activa y registrás peso/reps por
  serie. Recuerda el último peso usado, muestra la sugerencia del
  entrenador para esa sesión, avisa cuando hacés un PR, y tiene un
  temporizador de descanso entre series (con sonido y vibración).
- **Rutinas** — administrás tus rutinas. Podés tener varias (cada una con
  su fecha de inicio) y activar la que corresponda: útil porque tu rutina
  cambia cada ~3 meses pero el historial de progreso se conserva siempre,
  aunque cambies de rutina, porque se guarda por ejercicio, no por rutina.
  Se puede crear:
  - **Subiendo un Word (.docx)**: se lee en el propio navegador con
    [mammoth.js](https://github.com/mwilliamson/mammoth.js) (gratis, nada
    se sube a un servidor).
  - **Pegando el texto** de la rutina (funciona 100% offline).
  - **A mano**, agregando días y ejercicios uno por uno.
  En los tres casos se muestra un borrador editable (nombre del ejercicio,
  grupo muscular, series, reps, descanso) antes de guardar, porque la
  detección automática es una ayuda, no magia.
- **Entrenador** — periodización automática: divide el programa en bloques
  de N semanas (configurable) con una semana de descarga al final de cada
  bloque, sugiere cuánto peso subir según si cumpliste las repeticiones
  objetivo la última vez, y marca un nivel de fatiga por ejercicio y
  general a partir de tu historial reciente. Es una heurística de
  sobrecarga progresiva estándar — no reemplaza a un entrenador humano.
- **Progreso** — dashboard con gráficos: volumen por grupo muscular en el
  tiempo (y su desglose por ejercicio), o evolución del peso máximo de un
  ejercicio puntual, con historial completo.

- **Cuerpo** — altura, peso y medidas (cintura, pecho, brazo, pierna) con
  fecha: IMC, evolución de cada medida con gráfico, historial editable y
  exportación a .csv para analizar en Excel o Google Sheets.

El progreso se enlaza entre rutinas por el nombre del ejercicio: si se
escribe distinto la próxima vez, el historial se corta sin avisar. Para
evitarlo, el nombre se autocompleta con los ya usados al cargar una
rutina; y si ya pasó, en "Progreso → por ejercicio" hay un botón para
corregir el nombre y unir el historial dividido en uno solo.

Las superseries ("combinado con" en el Word) se entrenan intercaladas de
verdad: sin descanso entre los dos ejercicios, descanso recién al cerrar
la ronda completa. Se detectan solas al importar, y se pueden armar o
deshacer a mano en el editor de rutina (botón "Vincular con la
anterior"). Cada ejercicio también admite una nota libre (agarre, banda,
altura del asiento…), visible en "Hoy" y en "Entrenador".

Cualquier serie ya registrada (en "Hoy" o en el historial de "Progreso")
se puede tocar para editar el peso/reps/esfuerzo o borrarla, por si se
cargó mal.

Al registrar cada serie se puede marcar cómo se sintió (Fácil / Justo /
Al fallo). El entrenador lo usa para afinar la fatiga: entrenar al fallo
seguido cansa aunque se llegue a la meta de reps, algo que solo mirar las
reps no detecta. Y si la última sesión se sintió fácil, sugiere un salto
de peso mayor al habitual.

Cada ejercicio (mientras no tenga series cargadas) tiene un botón "No
realizado", para dejar registro de que ese día no se hizo en vez de
inventar una serie o dejarlo sin marcar. Y una vez arrancado, cualquier
serie pendiente que decidas no hacer (por cansancio, tiempo, etc.) se
puede marcar "Esta serie no se hizo" en vez de forzarla o dejarla
colgada; ambas se pueden deshacer, y cuentan como resueltas en la barra
de progreso del día. En "Hoy" hay un cuadro de notas libres y opcionales
para el día. En "Entrenador" hay un historial de
notas navegable semana por semana (con flechas ‹ ›): además de la nota
de esa semana, se ve y se puede editar la nota de cada uno de sus 7 días,
tanto en la semana actual como en cualquier semana pasada. Bajo cada día
también se ven, como chips, las series que se cargaron ese día; tocando
una se puede corregir su peso, reps, esfuerzo **o fecha** — pensado para
arreglar series que quedaron con la fecha del día siguiente por cargarlas
de noche (ver más abajo).

Hasta la versión 2026-09-30.2, la fecha del día se calculaba con
`.toISOString()` (hora UTC) en vez de la hora local: para husos horarios
negativos (como Argentina, UTC-3) eso hacía que una serie cargada desde
eso de las 21:00 quedara guardada con la fecha de "mañana". Ya está
corregido; las series viejas que hayan quedado mal fechadas se pueden
reubicar a mano desde el historial semanal de "Entrenador", como se
describe arriba.

Los datos viven solo en este dispositivo: la app pide almacenamiento
persistente al navegador y recuerda hacer un respaldo si pasa mucho
tiempo sin descargar uno. En "Hoy" se puede mantener la pantalla
encendida (Wake Lock), y el timer de descanso se recalcula solo si el
celular se bloquea o la app queda en segundo plano.

El descanso entre series también se ve en la pantalla de bloqueo, como
un control de reproducción (Media Session API) con el tiempo restante y
un botón para saltarlo. Para eso reproduce un audio silencioso mientras
dura el descanso — el truco habitual para esto, ya que la mayoría de los
sistemas solo arman ese panel mientras hay algo "sonando" — así que quien
no lo quiera puede desactivarlo desde el ⚙️ ("Mostrar el descanso en la
pantalla de bloqueo").

Las categorías (grupos musculares) se pueden agregar, renombrar y borrar
desde Rutinas → Categorías: los cambios se aplican a rutinas e historial.

Desde el ⚙️ del header se ajustan los parámetros del entrenador (semanas
por bloque, % de descarga, incrementos de peso) y se puede descargar/
restaurar un respaldo en `.json` (recomendado: los datos viven solo en
este navegador).

## Estructura

```
index.html         shell + navegación por pestañas
styles.css          tokens de diseño (claro/oscuro) + componentes
js/state.js         modelo de datos y persistencia (localStorage)
js/muscleGroups.js  grupos musculares, colores fijos, diccionario de palabras clave
js/parser.js        importar rutina desde Word/texto (heurístico)
js/coach.js         periodización, progresión de carga, fatiga
js/timer.js         temporizador de descanso
js/charts.js        gráficos SVG (línea y barras) sin librerías externas
js/icons.js         íconos SVG inline
js/vendor/          mammoth.js (lectura de .docx), incluida en el repo
fonts/              Inter y Oswald (OFL), incluidas para que funcionen sin conexión
sw.js, manifest.json  PWA: instalable y offline
js/main.js          router de pestañas + todas las vistas
```

## Uso

Abrí `index.html` en el navegador, o serví la carpeta con cualquier
servidor estático (los módulos de JS necesitan http, no `file://`):

```sh
python3 -m http.server 8000
```
