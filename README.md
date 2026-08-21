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
- `netlify/functions/` — 6 funciones serverless: `state`, `generate`,
  `dispense`, `cancel`, `delete-event` y `validate` (la que usa la página de
  escaneo). Ninguna requiere autenticación.
- `test/` — pruebas automáticas de la lógica (no hace falta correrlas, pero
  quedan documentadas; ver más abajo).

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
   y los archivos `netlify.toml`, `package.json`, `package-lock.json`,
   `README.md`, `.gitignore`) al recuadro de GitHub. Los navegadores modernos
   soportan arrastrar carpetas enteras manteniendo su estructura.
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
  códigos) y entregá uno por uno con el botón "Entregar el próximo
  código" — ahí podés anotar a quién se lo diste. Cada código entregado
  queda con su QR para mostrar o imprimir.
- **Escanear en la puerta**: quien controla el ingreso abre
  `https://tu-sitio.netlify.app/` (o `/index.html`) en el navegador del
  celular — **esta página es pública, no necesita la clave** — y toca
  "Activar cámara". Cada código habilita el ingreso una única vez; si se
  intenta usar de nuevo, se rechaza.
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

Esto corre 28 pruebas contra una versión simulada de Netlify Blobs en
memoria (incluye pruebas de aislamiento entre eventos, borrado de eventos,
migración automática de un estado guardado con la versión anterior de un
solo evento, y dos pruebas de concurrencia: varias entregas o escaneos
simultáneos compitiendo por el mismo código).
