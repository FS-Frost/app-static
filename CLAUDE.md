# CLAUDE.md

Guía para Claude Code (claude.ai/code) al trabajar en este repositorio.

## Qué es

App estática (SvelteKit 2 + Svelte 5 runes + TypeScript, `adapter-static`) que lee
hojas de respuestas de 45 u 80 preguntas con la cámara. **Sin backend**: cámara,
OpenCV y clasificación corren en el navegador. El detalle de arquitectura y las
decisiones de diseño están en [README.md](README.md); acá va lo que conviene tener
presente antes de tocar código.

## Comandos

```shell
bun install
bun run dev
bun run lint         # svelte-check + eslint. Debe pasar antes de commitear.
bun run test         # vitest
bun run test:e2e     # playwright (necesita chromium; CHROMIUM_PATH sirve)
bun run build
```

## Reglas de este repo

- **Nada de PII en el repositorio.** `examples/` son escaneos reales con nombre,
  colegio y RUT: está en `.gitignore`. Las fixtures de `tests/fixtures` van con la
  cabecera censurada. Si generas una fixture nueva, censura antes de copiarla.
- **El build de OpenCV es recortado y parcheado.** Antes de usar una función de
  OpenCV, revisa `src/lib/scan/opencv.ts`: si no está declarada ahí, probablemente
  no exista en el build (`contourArea`, `minAreaRect`, `moments`, `morphologyEx` no
  existen) y el error aparece en runtime, no al compilar.
- **No asumas la semántica del build: mídela.** Ya hay tres sorpresas documentadas
  (bounding rect antepuesto en `findContours`, `getPerspectiveTransform` inexacto,
  convención de `warpPerspective` calibrada en `warpConvention.ts`). Si algo sale
  torcido, sospecha del build antes que del álgebra.
- **La geometría de la hoja no se hardcodea.** Filas, bloques y alternativas se
  reconstruyen de la hoja detectada. Si te tienta agregar un factor fijo
  (`0.445 * pageHeight` y compañía), es la trampa en la que cayó el escáner
  anterior: revisa `grid.ts` primero.
- **Los umbrales de clasificación se validan contra hojas reales**, no a ojo. Un
  cambio en `classify.ts` o en la medición de relleno se comprueba con
  `bun run test:e2e` (45 respuestas conocidas, hoja fotografiada con sombra, hoja
  sin marcar).
- **Peor error posible: una pregunta marcada que se reporta en blanco.** Antes que
  adivinar, se reporta doble marca (`BD`) o se descarta el frame con un motivo en
  español que el usuario pueda accionar ("mira la hoja de frente").
- **Las anclas son para comparar en terreno, no para elegir por nosotros.** Si
  agregas una, va a `strategy.ts` con su descripción y con un test e2e contra la
  hoja que la justifica.
- **La asistencia es ayuda, no requisito.** Toda constraint de cámara (zoom, enfoque,
  punto de interés) va en try/catch: muchos teléfonos anuncian la capacidad y
  rechazan la constraint, y eso no puede impedir escanear. Con el interruptor apagado
  la app tiene que comportarse exactamente como antes.
- **Ojo con los espacios de coordenadas.** Hay cuatro en juego: frame, copia de 640
  para marcas, copia de 1280 para el QR y la zona de seguimiento (que desplaza el
  origen). Dos bugs ya salieron de mezclarlos: la estimación del QR sin restar el
  desplazamiento de la zona, y la zona del video aplicada a una foto de otra
  resolución.
- **La plantilla del QR se mide, no se estima.** El modo depuración imprime las
  esquinas del bloque en el marco del símbolo; esos son los números de `qrTemplates`.
  El contenido del QR nunca se escribe en una salida.

## Dónde tocar qué

| Necesidad | Archivo |
| --- | --- |
| Nuevo formato de hoja | `src/lib/scan/format.ts` |
| Anclas, tolerancias y modos de captura | `src/lib/scan/strategy.ts` |
| Guía de encuadre, zoom, seguimiento, autodisparo | `src/lib/scan/assist.ts` |
| Plantilla del QR y afinado con marcas | `src/lib/scan/qr.ts` |
| Ubicación de la hoja / validación del encuadre | `src/lib/scan/geometry.ts` |
| Reconstrucción de la grilla | `src/lib/scan/grid.ts` |
| Umbrales de marcado y consenso entre frames | `src/lib/scan/classify.ts` |
| Pipeline OpenCV | `src/lib/scan/worker.ts` |
| Cámara, estado, flash | `src/lib/scan/scanner.svelte.ts` |
| Caché offline | `static/worker.js` |

## Depurar una hoja que no se lee

1. Activar **Depurar** en la pantalla de formato y volver a escanear con
   **Usar una imagen**.
2. Mirar la hoja rectificada: si la grilla no cae sobre las burbujas, el problema
   es la ubicación (marcas/homografía), no la clasificación.
3. Si el frame se descarta, el panel muestra el motivo con los contornos, marcas y
   filas detectadas. `seguimiento` dice qué fracción del frame se está analizando:
   100% es búsqueda completa, menos es seguimiento enganchado.
4. `Relleno por burbuja` en el mismo panel da los valores con los que decidió
   `classify.ts`.
