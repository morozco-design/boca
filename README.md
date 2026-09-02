# Pase Único — backend real (Netlify)

Sistema de emisión y validación de entradas por código QR, con servidor real:
la lista de códigos vive en **Netlify Blobs** (persistente, compartida entre
todos los dispositivos), y la página de escaneo corre en un dominio normal
`https://tu-sitio.netlify.app`, así que la cámara del celular funciona sin
las restricciones que tienen los artifacts de Claude.

## Qué incluye

- `public/index.html` — página **pública** de escaneo (la abren los que
  controlan la entrada; no pide clave).
- `public/panel.html` — panel de **administración**: soporta **varios
  eventos a la vez** (un selector arriba de todo permite elegir entre ellos,
  crear uno nuevo o eliminarlo), y para el evento elegido: generar el lote,
  entregar códigos, cancelar entregas, buscar e imprimir. **Tampoco pide
  clave** — cualquiera con el link puede usarlo (ver la sección de
  Seguridad más abajo).
- `netlify/functions/` — 7 funciones serverless: `state`, `generate`,
  `dispense`, `cancel`, `delete-event`, `event-image` (imagen de fondo por
  evento) y `validate` (la que usa la página de escaneo). Ninguna requiere
  autenticación.
- `test/` — pruebas automáticas de la lógica (no hace falta correrlas, pero
  quedan documentadas; ver más abajo).
- `sample-coro-rodal.jpg` — imagen de prueba (formato vertical, con un logo
  placeholder de "Coro Rodal") pensada para probar la función de imagen de
  fondo sin tener que conseguir una imagen real primero.

## Múltiples eventos

El sistema puede manejar varios eventos en simultáneo (por ejemplo, dos
fiestas distintas), cada uno con su propio pool de códigos, totalmente
independiente entre sí:

- En `/panel.html`, arriba de todo hay un selector **"Evento actual"** con
  todos los eventos creados, más una opción **"+ Nuevo evento…"**.
- Al elegir **"+ Nuevo evento…"**, la sección "Generar lote" pide un nombre
  y una cantidad, y crea el evento con ese primer lote de códigos.
- Al elegir un evento existente, todo el panel (entregar código, cancelar,
  buscar, stats) pasa a operar sobre ese evento — y "Generar lote" pasa a
  sumarle más códigos (sin tocar los ya entregados o usados).
- El botón **"Eliminar este evento"** borra el evento y todos sus códigos
  de forma permanente (pide confirmación antes). Los códigos de un evento
  eliminado dejan de ser válidos en el escáner.
- Cada código QR es único **entre todos los eventos**, así que la página
  pública de escaneo (`/index.html`) no necesita saber de qué evento es un
  código — lo identifica automáticamente al escanearlo.

## Imagen de fondo por evento

Cada evento puede tener su propia imagen de fondo, para que el código QR que
se muestra al entregar o compartir una entrada funcione como un pase de
acceso completo (no sólo un QR pelado):

- En `/panel.html`, con un evento seleccionado, aparece la tarjeta **"Imagen
  de fondo del pase"** con una vista previa y un botón **"Subir imagen"**.
  Podés elegir cualquier foto o diseño (PNG, JPG o WEBP) — el panel la
  recorta y ajusta automáticamente a formato vertical (como la pantalla de
  un celular, proporción 9:16), así que no hace falta prepararla antes.
- Una vez subida, cada vez que se entrega o se comparte una entrada de ese
  evento (desde "Entregar entradas", "Ver entrada" o "Compartir por
  WhatsApp"), el código QR se dibuja dentro de una tarjeta blanca sobre esa
  imagen — el único texto que aparece junto al QR es el número de entrada,
  sin nombre de evento ni destinatario — y el resultado es una sola imagen
  lista para mostrar en la entrada o enviar por WhatsApp.
- El botón **"Quitar imagen"** saca la imagen del evento; a partir de ahí las
  entradas vuelven a mostrarse con el QR simple (como antes de subir una).
- Si un evento no tiene imagen cargada, todo sigue funcionando exactamente
  igual que antes (QR simple, sin tarjeta de fondo) — esto es totalmente
  opcional por evento.
- "Imprimir entregados" sigue imprimiendo QRs simples (sin la imagen), para
  no gastar tinta de más en las impresiones en lote.
- Al eliminar un evento, su imagen se borra junto con él.
- `sample-coro-rodal.jpg` (en la raíz del proyecto) es una imagen de prueba
  lista para usar con este botón, si querés ver el resultado sin buscar una
  imagen propia primero.

## 1. Desplegar en Netlify

**Importante:** este proyecto tiene funciones de servidor con una dependencia
(`@netlify/blobs`) que hay que instalar durante un build. **El drag-and-drop
manual de una carpeta/zip en la página de Deploys NO sirve para esto** —
Netlify no corre ningún build en ese modo, así que la dependencia nunca se
instala y las funciones fallan. Hay que desplegar por Git (recomendado) o
con la Netlify CLI.

### Opción recomendada: conectar un repositorio de GitHub

1. Si no tenés cuenta, creá una en [github.com/join](https://github.com/join).
2. Creá un repositorio nuevo y vacío en [github.com/new](https://github.com/new)
   (podés dejarlo privado, y no hace falta tildar "Add a README").
3. En la página del repo recién creado va a aparecer un link que dice
   **"uploading an existing file"** — hacé click ahí.
4. Descomprimí el .zip de este proyecto en tu computadora, y arrastrá **todo
   el contenido** de la carpeta (las carpetas `netlify/`, `public/`, `test/`,
   `scripts/`, y los archivos `netlify.toml`, `package.json`,
   `package-lock.json`, `README.md`, `.gitignore`, `sample-coro-rodal.jpg`)
   al recuadro de GitHub. Los navegadores modernos soportan arrastrar
   carpetas enteras manteniendo su estructura.
5. Abajo de todo, tocá **"Commit changes"** para subirlo a la rama principal.
6. Si ya tenés un sitio creado en Netlify (el que hiciste por drag-and-drop):
   entrá a ese sitio → **Project configuration → Build & deploy →
   Continuous deployment → Repository** → **Link repository** → elegí
   GitHub → seleccioná el repositorio que acabás de crear. Esto mantiene la
   misma URL que ya tenías.
   - Si preferís empezar de cero, también podés crear un sitio nuevo con
     **"Add new site" → "Import an existing project"** y elegir ese repo.
7. Netlify va a detectar el `netlify.toml` (funciones en `netlify/functions`,
   sitio en `public`) y esta vez sí va a correr `npm install` como parte del
   build antes de desplegar.
8. A partir de acá, cualquier actualización futura es: subir los archivos
   nuevos a ese mismo repositorio (reemplazando los viejos) → Netlify
   redespliega solo.

**Nota sobre la causa real de los errores de Blobs que fuimos resolviendo:**
el `package.json` de una versión anterior de este proyecto tenía fijada la
versión `^8.2.0` de `@netlify/blobs` por error (no coincidía con la versión
realmente instalada y probada, la `11.0.1`). Eso hacía que Netlify instalara
una versión vieja del paquete —con un comportamiento interno distinto al que
estaba probado y verificado acá— cada vez que desplegaba, sin importar qué
tan bien estuviera el resto del código. Ya está corregido: `package.json` y
`package-lock.json` ahora fijan la `11.0.1` (la misma que corren las
pruebas locales), así que el próximo deploy va a instalar la versión
correcta.

**Netlify Blobs** en general no necesita ninguna cuenta ni configuración
aparte — viene incluido con cualquier sitio de Netlify. Pero el mecanismo
automático que usa Netlify para "avisarle" a la función cuál es su Blobs
correspondiente (a través del evento que recibe la función) puede fallar en
algunos sitios sin motivo claro — si después de desplegar por Git seguís
viendo el error **"The environment has not been configured to use Netlify
Blobs"**, hace falta el paso manual de abajo.

### 1.1. Si el error de Blobs persiste: configurarlo a mano

Esto evita depender del mecanismo automático y funciona siempre:

1. **Conseguí el Project ID de tu sitio**: en Netlify, andá a **Project
   configuration → General → Project information**, y copiá el valor de
   **Project ID**.
2. **Creá un Personal Access Token**: andá a
   [app.netlify.com/user/applications#personal-access-tokens](https://app.netlify.com/user/applications#personal-access-tokens),
   tocá **New access token**, ponele un nombre (ej. "pase-unico-blobs"),
   elegí una fecha de expiración, y tocá **Generate token**. Copiá el token
   que te muestra — **es la única vez que lo vas a poder ver**.
3. En tu sitio: **Project configuration → Environment variables**, agregá
   dos variables:
   - `BLOBS_SITE_ID` con el Project ID que copiaste en el paso 1.
   - `BLOBS_TOKEN` con el token que copiaste en el paso 2.
4. Volvé a desplegar (**Deploys → Trigger deploy**) para que las funciones
   tomen las variables nuevas.

Con esas dos variables configuradas, las funciones se conectan a Netlify
Blobs directamente, sin depender del mecanismo automático que venía fallando.

## 2. Usar el sistema

- **Generar y entregar entradas**: entrá a `https://tu-sitio.netlify.app/panel.html`
  (ya carga directo, sin pedir clave), generá el lote (por ejemplo 300
  códigos) y entregalas con el botón "Entregar entradas" — podés anotar a
  quién se las diste y elegir **cuántas entregarle de una sola vez** (por
  ejemplo, 4 para una familia): cada una recibe su propio código QR único,
  todas a nombre de esa misma persona. Si pedís más de las que quedan
  disponibles, se entregan las que hay y el panel te avisa cuántas fueron.
  Al lado del botón aparece **"Ver entrada"**, que vuelve a mostrar la
  última entrega (con su QR) sin tener que buscarla en la lista. El único
  texto que aparece junto al QR generado es el **número de entrada** — nada
  de nombre de evento ni de destinatario.
- **Contadores del panel**: arriba de todo se muestran 4 números por
  evento — **Totales**, **Disponibles**, **Vendidas** (entregadas, pero
  todavía no usadas en la puerta) y **Usadas** (ya ingresaron con ese
  código).
- **Ver o compartir una entrada ya entregada**: en "Lote de códigos", cada
  entrada entregada tiene sus propios botones **"Ver entrada"** (la muestra
  igual que en el momento de entregarla) y **"Compartir por WhatsApp"**. En
  el celular, este último abre el selector de aplicaciones y comparte
  **únicamente la imagen** del pase (nada de texto ni título junto a ella);
  en la computadora, como los navegadores no permiten adjuntar un archivo a
  un link de WhatsApp de forma automática, el panel descarga esa misma
  imagen (y sólo la imagen) y abre WhatsApp Web para que la adjuntes a mano.
- **Escanear en la puerta**: quien controla el ingreso abre
  `https://tu-sitio.netlify.app/` (o `/index.html`) en el navegador del
  celular — **esta página es pública, no necesita la clave** — y toca
  "Activar cámara". Cada código habilita el ingreso una única vez. Al
  escanear, la pantalla se pone **verde** ("Ingreso habilitado") si el
  código es válido, o **roja** si hay algún problema (ya usado, no
  entregado, o no reconocido); en cualquiera de los dos casos, el escaneo
  se pausa hasta que tocás **"Escanear siguiente"**, para no arriesgarse a
  registrar dos entradas seguidas por error.
- **Cancelar una entrega** (si alguien no retiró la entrada, por ejemplo):
  en el panel, buscá el código y tocá "Cancelar entrega" — vuelve al pool
  de disponibles.
- Podés compartir el link del panel solo con el equipo de organización, y el
  link de escaneo con cualquiera que controle el ingreso — no hace falta
  que tengan cuenta de nada.

## 3. Seguridad

- **El panel (`/panel.html`) no pide clave.** Cualquiera que tenga ese link
  puede generar lotes nuevos, entregar códigos y cancelar entregas — a
  diferencia de la página pública de escaneo, el panel sí puede ver y
  modificar todos los tickets. En la práctica esto significa: no compartas
  el link del panel más que con quien organiza el evento, igual que no
  compartirías la planilla de invitados.
  - Si en algún momento querés protegerlo sin tocar código, Netlify tiene una
    función de **Password protection** a nivel de sitio o de ruta (en
    Project configuration → Visitor access, disponible en algunos planes)
    que podés aplicar sólo sobre `/panel.html`, sin depender de variables de
    entorno.
- Los códigos QR ya generados **no** se exponen nunca completos por la
  página pública de escaneo: `validate` sólo responde sobre el código
  puntual que se escanea, nunca devuelve la lista completa.
- Las escrituras en Netlify Blobs usan control de concurrencia optimista
  (ETags), así que si dos personas escanean el mismo código casi al mismo
  tiempo, sólo una de las dos lo valida — la otra recibe "código ya
  utilizado", sin condiciones de carrera.

## 4. Pruebas incluidas (opcional)

Si querés correr las pruebas automáticas de la lógica del servidor (no hace
falta para desplegar, ya están verificadas):

```bash
npm install
npm test
```

Esto corre 42 pruebas contra una versión simulada de Netlify Blobs en
memoria (incluye pruebas de aislamiento entre eventos, borrado de eventos,
entrega de varios códigos de una vez, migración automática y estable de un
estado guardado con la versión anterior de un solo evento, subida/lectura/
borrado de la imagen de un evento (incluido el borrado en cascada al
eliminar el evento), y dos pruebas de concurrencia: varias entregas o
escaneos simultáneos compitiendo por el mismo código). Aparte,
`test/playwright-check.js` corre 52 pruebas de navegador contra la interfaz
real (panel + escáner), incluyendo la entrega de varias entradas de una vez,
"Ver entrada", que compartir por WhatsApp mande sólo la imagen (sin texto),
los 4 contadores del panel, la subida/composición/borrado de la imagen de
fondo por evento, y en el escáner — con una cámara simulada que transmite un
QR real via `canvas.captureStream()` — el ciclo completo de escaneo válido
(pantalla verde), escaneo rechazado (pantalla roja) y el botón "Escanear
siguiente" (necesita un servidor estático local sirviendo `public/`, por
ejemplo `python3 -m http.server 8765 --directory public`, corriendo en
paralelo).
