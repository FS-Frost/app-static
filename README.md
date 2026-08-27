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

1. Elegir el formato (45 u 80 preguntas). Queda guardado en `localStorage`.
2. **Abrir cámara** y encuadrar la hoja completa, o **Usar una imagen** para leer
   una foto o un escaneo del carrete.
3. Cuando la lectura se estabiliza, se puede copiar (`01=A,02=,03=BC`) o bajar un
   CSV.

El interruptor **Depurar** muestra la hoja rectificada con la grilla dibujada
encima, los tiempos por etapa y el relleno medido de cada burbuja. Es la primera
herramienta a mirar cuando una hoja no se lee.

## Arquitectura

SvelteKit 2 + Svelte 5 (runes), TypeScript, `adapter-static`, sin servidor.

```
src/lib/scan/
  format.ts             formatos 45 / 80 (bloques, filas, alternativas)
  geometry.ts           puntos, cajas, clustering, cuadrilátero de las marcas
  homography.ts         homografía 4->4 resuelta en JS
  warpConvention.ts     calibración de warpPerspective del build custom
  grid.ts               reconstrucción de la grilla de burbujas
  classify.ts           relleno -> respuesta, y consenso entre frames
  worker.ts             pipeline OpenCV (corre en un worker clásico)
  scanner.svelte.ts     cámara, worker y estado de la vista
static/js/opencv-custom-build.js   build recortado de OpenCV.js (2,5 MB)
```

### El pipeline, por frame

1. `ImageBitmap` del video → `ImageData` → Mat RGBA → gris.
2. Copia reducida a 640 px de ancho y umbral adaptativo: se buscan las **marcas de
   registro** (los cuadrados negros macizos que la hoja trae impresos).
3. Con las dos filas de marcas que encierran el bloque de preguntas se arma una
   homografía a un rectángulo de 900 px de ancho. Lo rectificado es **el bloque de
   respuestas**, sin cabecera.
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

- **Unitarios (vitest):** geometría, ajuste de filas y columnas, y clasificación.
  Son puros y rápidos; cubren los casos raros (una fila no detectada, grupos de
  sobra, falta una marca de esquina, doble marca, lápiz claro).
- **End-to-end (playwright), proyecto `chromium`:** el pipeline completo, OpenCV
  incluido, contra las hojas de `tests/fixtures`: un escaneo real de 45 con sus 45
  respuestas conocidas, la misma hoja fotografiada en ángulo y con sombra, una hoja
  de 80 y una hoja sin marcar (que no debe inventar respuestas). Más dos tests que
  corren contra `http://localhost:5055/app-static/`, o sea la forma real del sitio:
  que funcione servido desde un subdirectorio (sin 404 y con el service worker
  alcanzando la app) y que **escanee sin conexión** tras haber escaneado con red.
- **End-to-end, proyecto `movil`:** viewport de teléfono (Pixel 5) y **cámara falsa
  de Chrome** alimentada con un video de una hoja, generado con ffmpeg desde
  `tests/fixtures/camara-45.png`. Es lo único que ejercita el camino de captura
  —permisos, `getUserMedia`, bombeo de frames, proporción de la vista previa— y no
  sólo el de "elegir una imagen". Sin ffmpeg, se salta.

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

- Sólo respuestas: **no** se leen RUT, nivel, curso ni forma, ni el QR.
- La hoja tiene que entrar completa en el cuadro, con sus marcas de registro
  visibles; una hoja cortada por el encuadre se rechaza a propósito.
- Los PDF de ejemplo de 80 preguntas vienen sin respuestas marcadas, así que la
  fixture de 80 con marcas es sintética (círculos dibujados sobre la hoja real).
- Probado en Chromium (escritorio y viewport de teléfono). En iPhone, Safari es otro
  motor: `getUserMedia` va, pero el flash no existe y conviene probarlo aparte.
