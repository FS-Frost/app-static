# Escáner de hojas de respuestas

App estática que lee hojas de respuestas de **45 u 80 preguntas** con la cámara del
teléfono. No hay backend: todo el procesamiento —cámara, OpenCV y clasificación—
ocurre en el navegador, y el sitio se sirve como estático desde GitHub Pages.

## Comandos

Runtime: **bun** (existe `bun.lock`).

```shell
bun install
bun run dev            # vite dev, http://localhost:5000
bun run build          # build estático -> build/
bun run preview        # sirve el build en el mismo puerto 5000
bun run serve:subpath  # sirve build/ en http://localhost:5055/app-static/
bun run lint           # svelte-check (tipos y plantillas) + eslint
bun run test           # vitest: geometría, grilla y clasificación
bun run test:e2e       # playwright: pipeline completo contra hojas reales
```

Los e2e necesitan un Chromium. Si ya hay uno en la máquina,
`CHROMIUM_PATH=/ruta/al/chrome bun run test:e2e` evita la descarga; si no,
`bunx playwright install chromium`. Playwright levanta él mismo el servidor
(`build` + `preview`).

Un solo test: `bun x vitest run src/lib/scan/grid.test.ts`, o `-t "nombre"`.

## Cómo se usa

En producción: **Chrome en un teléfono**, sitio estático en GitHub Pages
(`https://<usuario>.github.io/app-static/`). La cámara exige contexto seguro, que
Pages cumple por HTTPS; en desarrollo sirve `localhost`.

Conviene instalarla como app (Chrome → menú → *Instalar aplicación* / *Agregar a
pantalla de inicio*): abre a pantalla completa, en vertical, y arranca sin red.

1. Elegir el **formato** (45 u 80 preguntas), **cómo ubicar la hoja** y **cómo
   capturar**. Las tres elecciones quedan guardadas en `localStorage`.
2. **Abrir cámara**, o **Usar una imagen** para leer una foto o un escaneo del
   carrete.
3. Cuando la lectura se estabiliza, **la cámara se cierra sola** y aparecen las
   respuestas junto con dos tiempos: cuánto pasó desde que se abrió la cámara y
   cuánto tomó la detección desde que se capturó la imagen que sirvió. Se puede
   copiar (`01=A,02=,03=BC`) o bajar un CSV, y **Escanear otra** vuelve a abrir la
   cámara (esta vez con el detector ya cargado).

### Cómo ubicar la hoja

Tres anclas, seleccionables porque encuadrar a pulso es incómodo y cuál conviene
depende del teléfono, de la luz y de la costumbre:

| Ancla | En qué se apoya | Cuándo conviene |
| --- | --- | --- |
| **QR de la cabecera** (por defecto) | el QR, afinado con las marcas que se vean; si el QR no aparece, cae a las marcas | uso normal |
| **Automático** | prueba las vías por orden de confianza hasta que una cierra | comparar |
| **Marcas, tolerante** | las marcas negras impresas, aguantando ángulo y distancia; deduce una esquina que falte | comparar |
| **Marcas, estricto** | las mismas marcas, exigiendo hoja completa y de frente | cuando importa más no equivocarse que ir rápido |

El ancla **Automático** es una cascada dentro del mismo frame, ordenada por lo que
cuesta y por lo que suele funcionar:

1. marcas de registro con el umbral de siempre;
2. si eso no cierra, el QR (estimación + afinado con las marcas visibles);
3. si tampoco, dos umbrales alternativos —uno más blando para hojas con poco
   contraste, uno más duro para papel con brillo—.

Las vías se ordenan por confianza antes de leer: un cuadrilátero con sus cuatro
marcas a la vista se lee antes que uno con una esquina deducida, porque **leer es la
mitad del costo de un frame** y conviene empezar por el que más probablemente cierre.
La vía que funcionó se ve en el panel de depuración.

El ancla QR **no es sólo QR**: las marcas se buscan igual y sirven de respaldo
cuando el símbolo está sucio, tapado o fuera del cuadro. Una referencia que deja la
app inservible cuando falta no puede ser la de omisión.

El QR es chico y está lejos del bloque de
respuestas, así que estimar desde él amplifica el error —medido sobre una hoja
real, la esquina inferior derecha cae ~90 px del sitio correcto, suficiente para
que la grilla no cierre—. Por eso el QR **estima** y cada marca que aparezca cerca
de una esquina estimada la **corrige**. Con eso lee incluso una hoja a la que le
falta toda la fila inferior de marcas (hay un test que lo comprueba).

### Pantalla completa

Un interruptor (encendido por defecto) deja la cámara ocupando toda la pantalla
mientras se escanea, con los botones flotando abajo. La imagen se ajusta al **ancho**
y no se deforma (`object-fit: contain`): en una pantalla más alargada que el sensor
quedan franjas arriba y abajo, que es preferible a recortar la hoja o a estirarla.
Al terminar la lectura la pantalla completa se suelta sola para mostrar las
respuestas.

### Cómo capturar

- **Continua**: analiza el video y termina solo cuando la lectura se repite. Sin
  botones.
- **Una foto**: dispara con `ImageCapture.takePhoto()`, que da la resolución
  completa del sensor —muy por encima de la del stream— y permite encuadrar de más
  lejos. Un disparo basta: no hay consenso que hacer sobre una sola imagen. Si el
  navegador no lo soporta, cae al frame de video a resolución completa.

### Asistencia de encuadre

Un interruptor (encendido por defecto) que hace que el teléfono ayude a encuadrar
en vez de esperar a que le pongan la hoja perfecta:

- **Enfoque y exposición continuos**, pedidos a la cámara al abrirla y con el punto
  de interés puesto en la hoja detectada. Buena parte de los "no se ven las marcas"
  era la cámara enfocando el fondo o quemando el blanco del papel.
- **Zoom automático**: con la hoja ubicada, se calcula cuánto sobra de cuadro y se
  acerca la cámara. Se mueve de a poco (un tercio del camino) y como máximo dos
  veces por segundo, porque cada cambio de zoom reenfoca y mueve la imagen: hacerlo
  de golpe pierde el enganche justo cuando lo tenía. Tope en 4x.
- **Seguimiento**: tras un acierto, el frame siguiente se busca sólo alrededor de la
  última posición. No es sólo velocidad — al recortar antes de reducir a 640 px, las
  marcas quedan más grandes en la imagen analizada, así que también se detecta mejor.
  Se suelta después de dos frames sin encontrar la hoja.
- **Guía discreta**: rectángulo objetivo punteado y un diagnóstico corto ("la hoja
  se sale del cuadro", "acércate", "mira la hoja de frente"). Nada de flechas: la
  app se esfuerza sola y el texto sólo explica lo que falta. El criterio **no** es
  centrar el bloque de respuestas: quien encuadra ve la hoja entera y el bloque vive
  en los dos tercios de abajo, así que pedir centrado es pedir algo imposible. Lo que
  se exige es que entre completo, se vea grande y esté de frente.
- **Pista del QR para encontrar las marcas**: si un frame no ubica la hoja pero sí el
  QR, la búsqueda del frame siguiente se acota a donde el QR dice que está el bloque.
  Ahí las marcas aparecen mucho más grandes en la imagen analizada, y la hoja se
  engancha al frame siguiente.
- **Menos votos cuando el teléfono está quieto**: con dos lecturas idénticas y sin
  movimiento no se espera el tercer voto. El consenso de tres sigue siendo el camino
  normal, porque con la mano en movimiento dos frames seguidos pueden compartir el
  mismo error.
- **Autodisparo** en modo foto: se mide el movimiento entre frames sobre una
  miniatura de 32 px y, con la hoja encuadrada y dos lecturas seguidas quietas, se
  dispara solo. Mientras se encuadra, los frames de video se analizan **sin leer**
  respuestas (sólo ubicar la hoja y medir movimiento), que es más barato; la lectura
  sale de la foto a resolución completa.
- **Vibración corta al enganchar la hoja**, para encuadrar sin mirar la pantalla.
- **La cámara se cierra al terminar**: con la hoja leída no aporta nada y sí gasta
  batería y calienta el teléfono.

El overlay dibuja siempre lo que la app está viendo: marcas detectadas como puntos,
el QR si aparece, el cuadrilátero cuando cierra, la zona de seguimiento y el
contador de marcas. Es la diferencia entre "no detecta" y "ve tres marcas, falta la
de abajo a la derecha".

Con la asistencia apagada vuelve el comportamiento anterior: búsqueda en todo el
cuadro, sin tocar la cámara y con disparo manual. Está así para poder comparar.

El interruptor **Depurar** muestra la hoja rectificada con la grilla dibujada
encima, los tiempos por etapa y el relleno medido de cada burbuja. Es la primera
herramienta a mirar cuando una hoja no se lee.

## Arquitectura

SvelteKit 2 + Svelte 5 (runes), TypeScript, `adapter-static`, sin servidor.

```
src/lib/scan/
  format.ts             formatos 45 / 80 (bloques, filas, alternativas)
  strategy.ts           anclas, modos de captura y tolerancias
  assist.ts             guía de encuadre, zoom, zona de seguimiento y autodisparo
  geometry.ts           puntos, cajas, clustering, cuadrilátero de las marcas
  qr.ts                 QR: detección, plantilla por formato y afinado con marcas
  homography.ts         homografía 4->4 resuelta en JS
  warpConvention.ts     calibración de warpPerspective del build custom
  grid.ts               reconstrucción de la grilla de burbujas
  classify.ts           relleno -> respuesta, y consenso entre frames
  worker.ts             pipeline OpenCV (corre en un worker clásico)
  scanner.svelte.ts     cámara, worker y estado de la vista
static/js/opencv-custom-build.js   build recortado de OpenCV.js (2,5 MB)
```

### Cuánto tarda en detectar

Medido con la cámara falsa de Chrome (headless, en serie, mediana de tres corridas).
"Total" va desde apretar *Abrir cámara* hasta tener la hoja leída; "1ª lectura" es
desde que arranca el escaneo —o sea sin contar la apertura de la cámara—:

| Caso | Total | 1ª lectura |
| --- | --- | --- |
| Hoja centrada, buena luz | 1,43 s | 0,75 s |
| Hoja chica, torcida 7° y con sombra | 1,42 s | 0,58 s |
| Hoja con la fila inferior de marcas fuera del cuadro | 1,44 s | 0,65 s |
| Poca luz | 1,41 s | 0,65 s |

Antes de este trabajo: 2,47 s / 2,90 s / **nunca detectaba** / 2,47 s. Lo que lo
movió, en orden de impacto:

- **El detector se precarga** al abrir la app (2,5 MB de wasm) y la cámara se abre en
  paralelo, en vez de una espera detrás de la otra.
- **La hoja rectificada bajó de 900 a 760 px de ancho**: las burbujas siguen en ~18 px
  y rectificar, umbralizar y sacar contornos cuesta un 30% menos. La lectura era la
  etapa más cara de cada frame.
- **La grilla se reutiliza** entre frames consecutivos mientras el cuadrilátero se
  mueva menos de un tercio de burbuja, y se rehace igual cada seis frames para no
  arrastrar una deriva.
- **La caja de cada contorno se lee de sus primeros 8 bytes** en vez de recorrer sus
  puntos: el build antepone el bounding rect al contorno, y una hoja llena da ~1500
  contornos.
- **La cascada de vías** convirtió un caso que no se leía nunca en uno de ~2 s.
- **Dos votos en vez de tres** cuando el teléfono está quieto.

`tests/camara-velocidad.spec.ts` deja esto como guardia de regresión (con umbrales
generosos, porque en CI corre junto al resto de la suite). Para medir en serio:

```shell
BENCH_VIDEO=/ruta/otro-caso.y4m bunx playwright test tests/camara-velocidad.spec.ts --project=movil
```

### El pipeline, por frame

1. `ImageBitmap` del video → `ImageData` → Mat RGBA → gris.
2. Copia reducida a 640 px de ancho y umbral adaptativo: se buscan las **marcas de
   registro** (los cuadrados negros macizos que la hoja trae impresos). Con el ancla
   QR se busca además el símbolo, en una copia de 1280 px: a 640 el error en sus
   esquinas se multiplica demasiado.
3. Con las dos filas de marcas que encierran el bloque de preguntas —o con la
   estimación del QR afinada con las marcas visibles— se arma una homografía a un
   rectángulo de 900 px de ancho. Lo rectificado es **el bloque de respuestas**, sin
   cabecera.
4. Contornos sobre el bloque rectificado para reconstruir la grilla real: filas,
   bloques y alternativas salen de la hoja, no de factores fijos.
5. Relleno de cada burbuja como contraste contra el papel que la rodea, y
   clasificación comparando las alternativas de la misma pregunta.
6. Consenso: una respuesta se acepta cuando coincide en 3 de las últimas 6
   lecturas. Cuando toda la hoja está estable, el escaneo termina solo.

### Decisiones que no son arbitrarias

- **El trabajo va en un worker.** El hilo principal sólo bombea frames y pinta, así
  que la vista previa nunca se congela.
- **La hoja se ubica por las marcas impresas, no por el contorno del marco.** El
  contorno parece más cómodo, pero cualquier franja oscura en el borde de la imagen
  —los escaneos vienen con una— se fusiona con el marco y entonces la "hoja" pasa a
  ser el encuadre completo.
- **De las marcas se usan las dos filas que encierran el bloque**, elegidas por la
  proporción del bloque (0,70 en la hoja de 45; 0,75 en la de 80). Los extremos de
  todas las marcas no sirven: la hoja trae además marcas junto a la cabecera, y con
  una de menos el cuadrilátero sale trapecio.
- **La grilla se reconstruye desde la hoja.** El escáner anterior ubicaba cada
  burbuja con factores fijos más un "círculo de corrección"; acá las filas salen de
  agrupar las burbujas detectadas y las columnas de partir esas agrupaciones en
  tantos bloques como diga el formato.
- **El relleno se mide en gris, no sobre una máscara binaria**, y el umbral es
  relativo a las otras alternativas de la pregunta. Con umbral fijo alto se pierden
  las marcas de lápiz claro (aparecen como pregunta en blanco, el peor error en una
  corrección) y con umbral fijo bajo el papel gris empieza a contar como marca.
- **Doble marca se reporta como doble marca** (`BD`), no se resuelve a dedo.
- **Los límites de encuadre son configurables, la validación de la lectura no.** El
  modo tolerante acepta casi el doble de perspectiva porque la homografía la corrige
  igual; lo que nunca se relaja es el chequeo de que las filas ajustadas caigan sobre
  filas detectadas de verdad.
- **El contenido del QR no se escribe en ninguna salida**, ni depurando: identifica
  la prueba y al alumno.

### El build custom de OpenCV

`static/js/opencv-custom-build.js` viene del proyecto original: está recortado a
`core.countNonZero` + `imgproc` y trae el wasm embebido como data URI, así que
funciona sin red una vez cacheado. No existen `contourArea`, `minAreaRect`,
`moments` ni `morphologyEx`: `src/lib/scan/opencv.ts` declara sólo lo que hay.

Tres particularidades del build, todas descubiertas midiendo:

1. **`findContours` antepone el bounding rect al contorno**, ocupando el primer par
   de int32. Los puntos reales empiezan en `data32S[2]`; leer desde 0 mete una
   esquina en (-234736896, 234884352).
2. **`getPerspectiveTransform` devuelve una matriz que no manda las esquinas a su
   destino.** La homografía se resuelve en JS (`homography.ts`).
3. **`warpPerspective` no se asume estándar**: `warpConvention.ts` traslada una
   imagen conocida un píxel y mira dónde cayó, y con eso decide si pasarle el mapa
   directo o el inverso. Hoy el build resulta estándar; la calibración queda para
   que un cambio de build no se traduzca en hojas torcidas en silencio.

Los helpers del bundle (`matFromImageData`, `matFromArray`) están escritos contra
`window.cv`, que en un worker no existe: `loadOpenCv` apunta `window` a `self` y
deja ahí el módulo ya resuelto.

## Tests

- **Unitarios (vitest):** geometría, ajuste de filas y columnas, clasificación y la
  lógica de asistencia (guía, zoom, seguimiento, autodisparo).
  Son puros y rápidos; cubren los casos raros (una fila no detectada, grupos de
  sobra, falta una marca de esquina, doble marca, lápiz claro).
- **End-to-end (playwright), proyecto `chromium`:** el pipeline completo, OpenCV
  incluido, contra las hojas de `tests/fixtures`: un escaneo real de 45 con sus 45
  respuestas conocidas, la misma hoja fotografiada en ángulo y con sombra, una hoja
  de 80 y una hoja sin marcar (que no debe inventar respuestas). Más dos tests que
  corren contra `http://localhost:5055/app-static/`, o sea la forma real del sitio:
  que funcione servido desde un subdirectorio (sin 404 y con el service worker
  alcanzando la app) y que **escanee sin conexión** tras haber escaneado con red.
- **End-to-end, anclas:** cada ancla contra la hoja que la justifica —el QR con la
  hoja recortada sin la fila inferior de marcas, el modo tolerante con una marca
  tapada, y el estricto rechazando esa misma hoja—.
- **End-to-end, proyecto `movil`:** viewport de teléfono (Pixel 5) y **cámara falsa
  de Chrome** alimentada con un video de una hoja, generado con ffmpeg desde
  `tests/fixtures/camara-45.png`. Cubre captura continua, modo foto con autodisparo
  (sin tocar ningún botón), modo foto manual y que el seguimiento se enganche. Es lo único que
  ejercita el camino de cámara —permisos, `getUserMedia`, bombeo de frames,
  proporción de la vista previa— y no sólo el de "elegir una imagen". Sin ffmpeg, se
  salta.

Las fixtures salen de `examples/` con la cabecera censurada: los originales traen
nombre, colegio y RUT de alumnos reales, así que `examples/` está en `.gitignore` y
no se commitea.

Para reproducir una fixture desde un PDF de ejemplo:

```shell
pdftoppm -r 110 -f 1 -l 1 -png "examples/45 PREGUNTAS.pdf" hoja
convert hoja-01.png -fill white -stroke none \
  -draw "rectangle 100,90 840,188" -draw "rectangle 105,192 505,240" \
  -draw "rectangle 520,180 838,232" -draw "rectangle 520,240 838,535" \
  -draw "rectangle 340,365 510,510" -draw "rectangle 665,50 838,120" \
  tests/fixtures/hoja-45.png
```

Ojo con los rectángulos: si tapan las marcas de registro del bloque (y ≈ 555 en la
hoja de 45), la hoja deja de ubicarse.

El QR de las fixtures es **sintético** (`qrcode`, dependencia de desarrollo),
pegado en la posición y el tamaño del original: el QR real identifica prueba y
alumno y no puede quedar en el repositorio. La plantilla de `qr.ts` se midió con el
propio escáner, comparando en un mismo frame las esquinas que reporta jsQR con las
marcas detectadas — el modo depuración imprime esos números.

## PWA y despliegue

**Destino: GitHub Pages, repo `app-static`, Chrome de un teléfono.** El sitio queda
en `https://<usuario>.github.io/app-static/`, o sea colgando de un subdirectorio.
Eso condiciona tres cosas:

- **Rutas relativas.** El `<base>` que emite SvelteKit es relativo (`href="./..."`),
  así que no hay que parchear el `index.html` ni fijar `paths.base`. La URL del
  build de OpenCV se arma desde `document.baseURI` (`scanner.svelte.ts`), no desde
  el origen, que en un subdirectorio apuntaría a `/js/...` y daría 404.
- **Alcance del service worker.** Se registra como `./worker.js`, así que su alcance
  es `/app-static/` y cubre la app entera.
- **`start_url` y `scope` del manifiesto son `"."`**, relativos a su propia
  ubicación.

Estrategias de caché en `static/worker.js`:

| Contenido | Estrategia | Por qué |
| --- | --- | --- |
| Cascarón (HTML, JS, CSS) | network first | un despliegue nuevo se recoge solo y offline hay copia |
| `js/opencv-custom-build.js`, iconos | cache first, **precacheado al instalar** | 2,5 MB inmutables; sin el detector la app abre y no escanea |

Primera visita: ~3 MB (app + detector). Después arranca y escanea sin red.

### Publicar

1. Push a `main` (o `master`). `.github/workflows/main.yml` corre lint, unitarios,
   e2e y build, y publica `build/` en la rama `gh-pages`.
2. En el repo: *Settings → Pages → Source: Deploy from a branch → `gh-pages` / `/`*.
3. El workflow declara `permissions: contents: write`; sin eso el `GITHUB_TOKEN` de
   un repo nuevo es de sólo lectura y el push a `gh-pages` falla al final.

## Límites conocidos

- Sólo respuestas: **no** se leen RUT, nivel, curso ni forma. El QR se usa para
  ubicar la hoja, pero su contenido no se reporta.
- Con anclas de marcas, el bloque de respuestas tiene que entrar completo en el
  cuadro; se rechaza a propósito si está cortado. Con ancla QR basta que se vean el
  QR y alguna marca.
- **Leer por columnas sueltas (acumular bloque a bloque) no está implementado**: sin
  las marcas por bloque de la hoja de 80 —sólo tiene marcas en las cuatro esquinas
  del bloque completo— no hay forma de saber qué columna se está mirando sin leer los
  números impresos. El modo foto cubre la misma necesidad (acercarse para ganar
  nitidez) sin esa ambigüedad.
- Los PDF de ejemplo de 80 preguntas vienen sin respuestas marcadas, así que la
  fixture de 80 con marcas es sintética (círculos dibujados sobre la hoja real).
- Probado en Chromium (escritorio y viewport de teléfono). En iPhone, Safari es otro
  motor: `getUserMedia` va, pero el flash no existe y conviene probarlo aparte.
