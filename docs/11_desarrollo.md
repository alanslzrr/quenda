# Desarrollo y pruebas

Preparación del entorno local, ejecución de la API y de la aplicación web, datos de demostración y conjunto de comprobaciones que debe superar cada cambio. Las normas de contribución están en [CONTRIBUTING.md](../CONTRIBUTING.md).

## Desarrollo local

Requisitos: Node.js 24.21.0, pnpm 10.30.3 y Docker Compose para la base local. PostgreSQL está fijado en 17.11; `btree_gist` se instala mediante migración.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm db:local:config
docker compose --env-file .env.bootstrap.local up -d --wait db
pnpm db:bootstrap
pnpm db:migrate
pnpm dev
```

`db:local:config` genera contraseñas aleatorias en archivos locales excluidos de Git y no sobrescribe configuraciones existentes. `db:bootstrap` se ejecuta una sola vez sobre una base dedicada nueva: crea roles y esquemas; falla si ya existen. No utilizarlo sobre bases compartidas con otros productos. Las contraseñas de roles deben tener al menos 24 caracteres ASCII imprimibles; los generadores locales usan valores hexadecimales. Bootstrap y provisión del worker derivan verificadores SCRAM-SHA-256 con sal aleatoria antes de ejecutar SQL: las sentencias de creación o cambio de rol no contienen la contraseña en claro.

La API escucha en `127.0.0.1:3000`. `GET /health/live` comprueba el proceso; `GET /health/ready`, las conexiones y los privilegios de ejecución. No devuelven credenciales ni datos del dominio.

El proceso web recibe exclusivamente la configuración de `.env.local`. Las credenciales de migración y administración permanecen en archivos separados. El runtime de autenticación no posee sus tablas; sus migraciones se ejecutan con el rol de migración.

## Aplicación web

`web/` contiene la SPA React. Utiliza las mismas versiones de Node.js y pnpm que el backend y conserva su propio archivo de dependencias bloqueadas.

```sh
pnpm --dir web install --frozen-lockfile --ignore-scripts
pnpm --dir web dev
```

Vite escucha en `http://127.0.0.1:5173` y dirige `/api` al backend local en el puerto 3000. Para utilizar la interfaz local, `AUTH_ORIGIN` debe ser `http://127.0.0.1:5173` en `.env.local` y `.env.worker.local` (la configuración generada usa `http://localhost:3000`); no se reescribe el encabezado `Origin`. La aplicación utiliza rutas API relativas y cookies del mismo origen. Los secretos permanecen en el backend.

```sh
pnpm --dir web build
pnpm --dir web test
pnpm --dir web exec playwright install chromium
PG_BIN=/ruta/a/postgresql-17.11/bin pnpm --dir web test:browser
```

`build` comprueba tipos y genera archivos estáticos en `web/dist`. `test:browser` ejecuta la suite dos veces, cada una con su servidor y su base temporal: primero escritorio y móvil, después tableta. Los argumentos, como un archivo de pruebas, se aplican a las dos. Ambas ejecuciones necesitan los puertos 3000 y 5173 libres. Las pruebas de navegador del catálogo utilizan respuestas controladas para comprobar presentación, errores, preferencias y accesibilidad. Las de cuenta, reservas y administración municipal y de plataforma utilizan Better Auth, una base PostgreSQL temporal, municipios sintéticos aislados y correo local, sin credenciales de la instancia de desarrollo. Las respuestas controladas verifican también cambios de normas, cuotas, recuperación de respuestas perdidas y aceptación pendiente. Requieren los puertos 3000 y 5173 libres. Las pruebas PostgreSQL verifican los contratos y el aislamiento. Las fuentes conservan sus avisos en `web/public/licenses`; la compilación añade las [licencias de las dependencias empaquetadas](https://vite.dev/config/build-options.html#build-license) en `web/dist/licenses/dependencies.md`.

La aplicación se puede instalar desde el navegador en móvil, tableta u ordenador («Instalar aplicación» o «Añadir a pantalla de inicio»). Se abre en su propia ventana con el icono de Quenda y es la misma web: no hay una versión aparte que publicar ni mantener. No funciona sin conexión ni envía notificaciones, porque reservas y disponibilidad se consultan siempre en el servidor. En iOS la aplicación instalada guarda su propia sesión, separada de Safari. Nombre e iconos están en `web/public/manifest.webmanifest` y `web/public/icons/`; nginx sirve el manifiesto como `application/manifest+json`.

La reserva recorre municipio, instalación, espacio, día y hora, y revisión; «Reservar» está siempre en la navegación y parte del municipio favorito si lo hay. El [mapa de navegación](09_navegacion.md) describe rutas, contexto entre pasos y dónde se guarda el favorito. Día y duración viajan en la URL (`fecha`, `duracion`) hasta la revisión de la reserva.

Para revisar la interfaz con datos ficticios, `PG_BIN=/ruta/a/postgresql-17.11/bin pnpm demo:local` crea una base temporal con dos municipios de demostración, sus instalaciones y reservas de una vecina, y levanta la API en el puerto 3100. El comando muestra las cuentas, la contraseña común y el arranque de la web (`QUENDA_API=http://127.0.0.1:3100 pnpm --dir web exec vite --host 127.0.0.1 --port 5174`). Los datos desaparecen al detenerlo y no se usan en las pruebas.

El acceso de administración de la demo mantiene MFA: `pnpm demo:code` genera un código temporal solo después de comprobar que el archivo local privado pertenece al proceso vigente. No reutilizar secretos de registros anteriores. El [procedimiento de acceso de demostración](../test/demo/README.md) describe las cuentas, los archivos protegidos y la recuperación cuando cambia el arranque.

La cuenta ofrece datos personales, preferencias, contraseña, MFA, sesiones, invitaciones, descarga de datos y baja. Los enlaces de recuperación, reactivación y cambio de correo requieren una acción expresa; abrirlos no ejecuta la operación.

Las reservas incluyen confirmación de condiciones, historial por municipio, modificación, cancelación, aceptación de normas pendientes y avisos. Una respuesta incierta conserva en la pestaña la clave y el contenido del comando para su comprobación expresa, dentro del plazo publicado por la API. No se reenvía automáticamente ni se conserva después de cerrar sesión.

La administración municipal se abre desde «Gestión», según los permisos de la cuenta. Incluye instalaciones, unidades, normas versionadas, horarios y excepciones, condiciones de reserva, agenda diaria, bloqueos y reubicaciones con motivo. Los controles reflejan los permisos vigentes; la API autoriza cada operación. La apariencia municipal parte de un catálogo de temas con versión clara y oscura; permite ajustar acento, fondo y texto por modo, la tipografía y la forma de las esquinas. El resto de colores se calcula para mantener el contraste, y el servidor rechaza combinaciones ilegibles. Cada cambio se ve al instante en toda la aplicación sin modificar preferencias personales ni publicarse hasta guardar; el borrador sin guardar sobrevive a una navegación o recarga en la misma pestaña.

La sección «Personal y permisos» permite invitar administradores y gestores, delimitar operaciones por municipio o unidad, consultar asignaciones e invitaciones y retirar permisos. Las sustituciones de gestores requieren nueva aceptación; el relevo ordinario conserva un administrador habilitado sin caducidad. La retirada por seguridad afecta solo al municipio. El destinatario facilita su identificador desde los datos de su cuenta y acepta desde sus invitaciones con MFA.

La sección «Convenios» permite crear versiones, aprobar la participación municipal, activar y suspender el convenio. La reapertura de una unidad exige retirar expresamente su vinculación, sin alterar las reservas existentes. «Acreditaciones» permite emitir desde la versión del convenio y revocar seleccionando una emisión propia o indicando una referencia conocida; no ofrece consultas de acreditaciones ajenas. Estas operaciones conservan la recuperación idempotente. El estado registrado de una versión no sustituye la comprobación de vigencia del backend.

«Conservación y derechos» utiliza permisos explícitos de consulta y ejecución, independientes del rol administrativo. Permite consultar políticas, excepciones y conflictos, registrar políticas aprobadas sin plazos predeterminados, ejecutar actuaciones autorizadas y preparar copias parciales. El ámbito municipal no accede a identidad global ni a otros municipios; el global excluye actividad municipal. Una respuesta sin confirmación impide repetir la operación hasta comprobar su resultado, también después de recargar la pestaña.

La administración de plataforma permite incorporar municipios, sustituir su invitación inicial, recuperar responsables municipales, gestionar operadores y concesiones de privacidad global, y suspender identidades comprometidas. Exige permiso de operador y MFA reciente, sin acceso implícito a datos municipales ni de privacidad. Las invitaciones requieren aceptación desde el perfil; la recuperación municipal registra la referencia de verificación de autoridad. La inicialización del primer operador y la recuperación sin operadores habilitados requieren mantenimiento separado.

«Indicadores» consulta el municipio completo o una unidad según los permisos vigentes. La ocupación sin oferta se muestra como «no aplicable». «Exportar reservas» descarga el JSON versionado del ámbito autorizado, sin truncar resultados ni conservar el archivo en el almacenamiento del navegador. «Informes conjuntos» entrega únicamente el mes autorizado para el destinatario; una publicación suprimida no muestra métricas ni causas. Los administradores participantes registran la revisión de riesgo sobre el contexto exacto del destinatario, con recuperación idempotente y nueva comprobación si cambia el historial.

`TRUSTED_PROXY_CIDRS` es opcional: vacío no confía en proxies. Admite IP y CIDR explícitos separados por comas, no nombres, comodines ni redes universales. Configurarlo únicamente con los proxies controlados del despliegue; estos deben sanear las cabeceras reenviadas y restringirse el acceso directo al backend. Fastify resuelve el cliente para los límites públicos y de autenticación; `AUTH_ORIGIN` sigue fijando el origen autorizado. Sin configuración, un proxy convencional agrupa a sus clientes bajo el mismo límite. No se activa infraestructura automáticamente.

## Comprobaciones

```sh
pnpm check
PG_BIN=/ruta/a/postgresql-17.11/bin pnpm test:integration
pnpm build
pnpm --silent openapi > /tmp/quenda-openapi.json
```

El contrato generado se valida también con herramientas ajenas al repositorio: `pnpm test` lo comprueba con `@apidevtools/swagger-parser` y, desde fuera, `npx @redocly/cli lint /tmp/quenda-openapi.json` debe terminar sin errores. Cada operación declara resumen, etiqueta, identificador único y sus requisitos de sesión (vacíos en las públicas); `servers` apunta al mismo origen que la aplicación.

Las pruebas de integración crean una instancia PostgreSQL temporal con contraseñas aleatorias y la eliminan al terminar; no utilizan la base de desarrollo. Requieren los binarios locales `initdb`, `pg_ctl` y `postgres` de la versión indicada. En macOS con Homebrew, `PG_BIN` puede ser `/opt/homebrew/opt/postgresql@17/bin` si contiene esa versión.

La comprobación de arquitectura impide dependencias circulares y accesos a archivos privados de otro módulo. Cada módulo expone su API por `src/modules/<nombre>/index.ts`; la composición inyecta los puertos que evitan dependencias inversas. Las migraciones aplicadas son inmutables y su hash se verifica antes de aplicar otras.

`pnpm build` genera `dist/`. Para comprobar el artefacto compilado con la configuración local: `node --env-file=.env.local dist/server.js`. En ejecución, `pnpm start` recibe las variables desde el entorno. SIGINT y SIGTERM cierran el servidor y sus pools.

### Validación antes de abrir una pull request

Las validaciones largas se ejecutan en local, no en GitHub Actions. Con PostgreSQL 17.11 disponible en `PG_BIN` y los puertos 3000 y 5173 libres, desde un árbol limpio y con la revisión que se va a enviar:

```sh
PG_BIN=/ruta/a/postgresql-17.11/bin pnpm validate
```

`pnpm validate` encadena, y se detiene en el primer fallo: `pnpm check` (tipos, lint, pruebas unitarias y HTTP, incluido el contrato OpenAPI), `pnpm --dir web check` y `pnpm --dir web build`, la suite de integración PostgreSQL, las pruebas de navegador con axe (reglas WCAG 2.0 y 2.1, niveles A y AA), la construcción de las imágenes de API y web y `pnpm test:oci`. Requiere Docker y `pnpm --dir web exec playwright install chromium`. Tarda decenas de minutos; una pull request se abre cuando todo termina bien. Para ensayar el rendimiento o inventariar licencias, que no forman parte del encadenado, usar `pnpm test:performance` y `pnpm licenses:inventory`; sus resultados se conservan fuera de Git y se comparan solo con mediciones del mismo entorno.

### Integración continua

Los workflows están en [.github/workflows](../.github/workflows) y se limitan a comprobaciones básicas de menos de cinco minutos en cada pull request y en cada cambio incorporado a `main`:

| Comprobación | Contenido |
|---|---|
| `Backend checks` | `pnpm check`, compilación, generación de OpenAPI y validación de sintaxis de la composición de referencia. |
| `Web checks` | Tipos, lint, pruebas unitarias y compilación del paquete estático. |

Los ejecutores utilizan Ubuntu 24.04, Node de `.nvmrc` y pnpm de `package.json`. La instalación respeta el lockfile y no ejecuta scripts de dependencias. Las acciones externas están fijadas por SHA, el token solo permite leer el repositorio y no se conserva en Git. No se utilizan secretos de aplicación, cachés compartidas, servicios reales ni credenciales cloud. La configuración no despliega servicios ni ejecuta Terraform. [Seguridad de GitHub Actions](https://docs.github.com/en/actions/reference/security/secure-use).

## Ensayo de rendimiento

`PG_BIN=/ruta/postgresql17/bin pnpm test:performance` crea una base temporal con 3 municipios, 30 unidades y 3.000 reservas históricas sintéticas, autentica 10 sesiones y ejercita HTTP en loopback. Tras 60 segundos de calentamiento separado, programa 3.000 solicitudes en 10 minutos: 70 % consulta de reservas propias, 10 % disponibilidad y 20 % altas de reservas. No omite solicitudes lentas ni cuenta ensayos abreviados como aceptación. `--smoke` reduce únicamente calentamiento y medición para comprobar el montaje; conserva el conjunto de datos completo y nunca aprueba el escenario.

`pnpm test:performance:history` prepara por separado 50.000 reservas históricas y 50.000 eventos, comprueba la paginación inicial, siguiente y por día y selecciona 100 candidatos de conservación. Registra cinco muestras calientes por operación y revisión/estado del árbol en un JSON temporal; no sustituye la carga sostenida.

El informe JSON privado en el directorio temporal incluye revisión, cambios pendientes, entorno, muestras, percentiles, errores, abortos, conexiones y retraso de avisos. El correo usa transporte sintético sin latencia externa. Para aprobar exige una revisión limpia, todas las solicitudes válidas, los límites p95 definidos y ausencia de avisos sin aceptar al terminar la espera acotada. Los resultados describen este equipo y esta mezcla de operaciones, no un SLA ni capacidad del proveedor de correo o de otros endpoints.
