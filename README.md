# Quenda

API municipal con TypeScript, Fastify y PostgreSQL. [Especificación técnica](docs/README.md).

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

La reserva recorre municipio, instalación, espacio, día y hora, y revisión; «Reservar» está siempre en la navegación y parte del municipio favorito si lo hay. El [mapa de navegación](docs/09_navegacion.md) describe rutas, contexto entre pasos y dónde se guarda el favorito. Día y duración viajan en la URL (`fecha`, `duracion`) hasta la revisión de la reserva.

Para revisar la interfaz con datos ficticios, `PG_BIN=/ruta/a/postgresql-17.11/bin pnpm demo:local` crea una base temporal con dos municipios de demostración, sus instalaciones y reservas de una vecina, y levanta la API en el puerto 3100. El comando muestra las cuentas, la contraseña común y el arranque de la web (`QUENDA_API=http://127.0.0.1:3100 pnpm --dir web exec vite --host 127.0.0.1 --port 5174`). Los datos desaparecen al detenerlo y no se usan en las pruebas.

El acceso de administración de la demo mantiene MFA: `pnpm demo:code` genera un código temporal solo después de comprobar que el archivo local privado pertenece al proceso vigente. No reutilizar secretos de registros anteriores. El [procedimiento de acceso de demostración](test/demo/README.md) describe las cuentas, los archivos protegidos y la recuperación cuando cambia el arranque.

La cuenta ofrece datos personales, preferencias, contraseña, MFA, sesiones, invitaciones, descarga de datos y baja. Los enlaces de recuperación, reactivación y cambio de correo requieren una acción expresa; abrirlos no ejecuta la operación.

Las reservas incluyen confirmación de condiciones, historial por municipio, modificación, cancelación, aceptación de normas pendientes y avisos. Una respuesta incierta conserva en la pestaña la clave y el contenido del comando para su comprobación expresa, dentro del plazo publicado por la API. No se reenvía automáticamente ni se conserva después de cerrar sesión.

La administración municipal se abre desde «Gestión», según los permisos de la cuenta. Incluye instalaciones, unidades, normas versionadas, horarios y excepciones, condiciones de reserva, agenda diaria, bloqueos y reubicaciones con motivo. Los controles reflejan los permisos vigentes; la API autoriza cada operación. La apariencia municipal dispone de vista previa, guardado y restauración de paletas accesibles, con una vista previa temporal de toda la aplicación que no modifica preferencias personales ni publica cambios.

La sección «Personal y permisos» permite invitar administradores y gestores, delimitar operaciones por municipio o unidad, consultar asignaciones e invitaciones y retirar permisos. Las sustituciones de gestores requieren nueva aceptación; el relevo ordinario conserva un administrador habilitado sin caducidad. La retirada por seguridad afecta solo al municipio. El destinatario facilita su identificador desde los datos de su cuenta y acepta desde sus invitaciones con MFA.

La sección «Convenios» permite crear versiones, aprobar la participación municipal, activar y suspender el convenio. La reapertura de una unidad exige retirar expresamente su vinculación, sin alterar las reservas existentes. «Acreditaciones» permite emitir desde la versión del convenio y revocar seleccionando una emisión propia o indicando una referencia conocida; no ofrece consultas de acreditaciones ajenas. Estas operaciones conservan la recuperación idempotente. El estado registrado de una versión no sustituye la comprobación de vigencia del backend.

«Conservación y derechos» utiliza permisos explícitos de consulta y ejecución, independientes del rol administrativo. Permite consultar políticas, excepciones y conflictos, registrar políticas aprobadas sin plazos predeterminados, ejecutar actuaciones autorizadas y preparar copias parciales. El ámbito municipal no accede a identidad global ni a otros municipios; el global excluye actividad municipal. Una respuesta sin confirmación impide repetir la operación hasta comprobar su resultado, también después de recargar la pestaña.

La administración de plataforma permite incorporar municipios, sustituir su invitación inicial, recuperar responsables municipales, gestionar operadores y concesiones de privacidad global, y suspender identidades comprometidas. Exige permiso de operador y MFA reciente, sin acceso implícito a datos municipales ni de privacidad. Las invitaciones requieren aceptación desde el perfil; la recuperación municipal registra la referencia de verificación de autoridad. La inicialización del primer operador y la recuperación sin operadores habilitados requieren mantenimiento separado.

«Indicadores» consulta el municipio completo o una unidad según los permisos vigentes. La ocupación sin oferta se muestra como «no aplicable». «Exportar reservas» descarga el JSON versionado del ámbito autorizado, sin truncar resultados ni conservar el archivo en el almacenamiento del navegador. «Informes conjuntos» entrega únicamente el mes autorizado para el destinatario; una publicación suprimida no muestra métricas ni causas. Los administradores participantes registran la revisión de riesgo sobre el contexto exacto del destinatario, con recuperación idempotente y nueva comprobación si cambia el historial.

`TRUSTED_PROXY_CIDRS` es opcional: vacío no confía en proxies. Admite IP y CIDR explícitos separados por comas, no nombres, comodines ni redes universales. Configurarlo únicamente con los proxies controlados del despliegue; estos deben sanear las cabeceras reenviadas y restringirse el acceso directo al backend. Fastify resuelve el cliente para los límites públicos y de autenticación; `AUTH_ORIGIN` sigue fijando el origen autorizado. Sin configuración, un proxy convencional agrupa a sus clientes bajo el mismo límite. No se activa infraestructura automáticamente.

## Autenticación local

Better Auth utiliza el esquema `auth`, con migraciones ejecutadas fuera del proceso web. Kysely configura su adaptador PostgreSQL con transacciones; las consultas del dominio utilizan `pg`.

`AUTH_ORIGIN` fija el origen permitido y `AUTH_SECRET` se genera con la configuración local. El registro exige verificar el correo antes de iniciar sesión. Con el transporte local, los mensajes de verificación y recuperación se guardan en `.local/mail`, con permisos privados y fuera de Git. Este transporte no envía correo y no admite ejecución en producción.

Las rutas habilitadas están bajo `/api/auth`; `GET /api/auth/open-api/generate-schema` devuelve su contrato OpenAPI. `GET /api/me` devuelve la identidad verificada y si la sesión ha superado MFA. Las cookies son Secure, HttpOnly y SameSite=Lax; fuera del desarrollo en loopback se requiere HTTPS. La autenticación no concede permisos municipales.

## Administración municipal por API

`POST /api/municipalities` recibe `name`, `timezone`, `administratorId` e `invitationExpiresAt` (ISO 8601). Requiere una sesión del operador con MFA y devuelve `tenantId` e `invitationId`. La cuenta destinataria debe existir; el alta no le concede permisos todavía.

El destinatario acepta con MFA mediante `POST /api/municipalities/{tenantId}/administrator-invitations/{invitationId}/accept` y cuerpo `{}`. Ambas operaciones requieren la cookie de sesión y el encabezado `Origin` exactamente igual a `AUTH_ORIGIN`; rechazan campos adicionales. El contrato generado por `pnpm openapi` incluye estas rutas y `/api/me` sin necesitar una base activa.

La prueba MFA para estas operaciones caduca a los cinco minutos. La API responde `403` con `REAUTHENTICATION_REQUIRED`; verificar de nuevo mediante `POST /api/auth/two-factor/verify-totp` permite repetir la operación sin cerrar la sesión. Un intento incorrecto no renueva la prueba y mantiene los límites de intentos de Better Auth.

Las operaciones municipales comparten un límite de 60 intentos por cuenta en ventanas de 60 segundos. Los intentos autenticados consumen cuota aunque la operación se rechace; al agotarse, la respuesta es `429 RATE_LIMITED` con `Retry-After`. Los límites de autenticación y TOTP son independientes.

Un administrador con MFA reciente puede invitar mediante `POST /api/municipalities/{tenantId}/administrator-invitations` (`accountId`, `expiresAt`) y revocar una invitación pendiente mediante `POST /api/municipalities/{tenantId}/administrator-invitations/{invitationId}/revoke` (`{}`). La aceptación comprueba también que el emisor conserva su autorización; revocar una invitación aceptada no retira el rol ya concedido.

El rol se revoca con `POST /api/municipalities/{tenantId}/administrators/{accountId}/revoke` y `{ "reason": "..." }`. La revocación conserva perfil e historial, registra el motivo e invalida las invitaciones pendientes emitidas por ese administrador. Para recuperar el rol debe aceptar una nueva invitación emitida después de la revocación; las invitaciones anteriores no se reactivan.

`GET /api/me/administrator-invitations` devuelve las invitaciones de la cuenta autenticada, con municipio, vencimiento y estado. Devuelve hasta 20 elementos y `nextCursor`; la página siguiente utiliza `?after=...`. No admite filtros por otra cuenta ni requiere MFA para consultar las invitaciones propias.

El operador puede sustituir una invitación inicial caducada o incorrecta con `POST /api/municipalities/{tenantId}/initial-administrator-invitation/replace` (`accountId`, `expiresAt`, `reason`). La sustitución invalida las invitaciones iniciales pendientes y conserva su auditoría. Esta vía se cierra después de la primera aceptación y no se reabre al revocar administradores.

Al invitar a un administrador, `roleExpiresAt` permite fijar la caducidad del rol; es independiente de `expiresAt`, que limita la aceptación. Omitirlo o enviar `null` concede el rol sin vencimiento temporal, sujeto a revocación. Un permiso vencido no autoriza operaciones ni nuevas aceptaciones de sus delegaciones; renovarlo requiere otra invitación y no reactiva las anteriores. Un administrador con permiso temporal solo puede conceder roles de administrador que venzan, como máximo, cuando vence el suyo (`403 FORBIDDEN` en otro caso).

`GET /api/municipalities/{tenantId}/profiles` permite al administrador con MFA reciente consultar los perfiles vinculados a ese municipio. Devuelve `accountId`, `createdAt` y `accountLabel` (nombre y correo de presentación), hasta 20 elementos y `nextCursor`; la página siguiente utiliza `?after=...`. No incluye cuentas sin vínculo municipal ni credenciales; la proyección de nombre y correo está limitada al ámbito autorizado. Los gestores y operadores sin rol administrativo en ese municipio no pueden utilizar esta consulta.

`GET /api/municipalities/{tenantId}/administrators` muestra la última asignación administrativa de cada cuenta, su invitación de origen, vigencia, revocación y estado `active` al consultar. `GET /api/municipalities/{tenantId}/administrator-invitations` muestra el historial de invitaciones, incluida su aceptación. Ambas consultas requieren administración municipal y MFA reciente; devuelven hasta 20 elementos y `nextCursor`. Una invitación aceptada no acredita autoridad actual: una revocación o renovación puede haber cambiado la asignación.

## Nombre de la cuenta

`POST /api/auth/update-user` recibe exclusivamente `{ "name": "..." }` y modifica el nombre del titular de la sesión. El nombre admite hasta 200 caracteres, se guarda sin espacios exteriores y no puede quedar vacío ni contener caracteres de control. La operación no modifica el correo, la verificación, el MFA ni los permisos. El nombre actualizado se consulta mediante `GET /api/auth/get-session`. Cambiar el nombre no acredita una identidad legal.

## Baja y reactivación de cuenta

`POST /api/me/deactivation` recibe `{ "confirm": true, "password": "..." }`. Exige sesión, `Origin` autorizado y contraseña actual. Con MFA habilitado, la verificación del segundo factor debe tener menos de cinco minutos. Rechaza reservas confirmadas futuras o en curso de cualquier municipio (`409 ACCOUNT_HAS_FUTURE_RESERVATIONS`) y dejar una última responsabilidad sin sustituto habilitado indefinido (`409 ACCOUNT_HANDOVER_REQUIRED`).

La baja revoca sesiones, permisos propios e invitaciones pendientes recibidas y emitidas, sin retirar permisos ya aceptados por otros usuarios. Conserva identidad, perfiles, reservas y auditoría. No elimina datos personales ni cancela reservas.

`POST /api/account/reactivation/request` recibe `email` y `password`; responde `202` sin revelar la existencia o estado de la cuenta. Si procede, envía un enlace de un solo uso, válido diez minutos. `POST /api/account/reactivation/confirm` recibe `token`, `password` y `totpCode` o `backupCode` —nunca ambos— cuando había MFA. El código de respaldo se consume con la reactivación. Permite cinco intentos por prueba, además de límites compartidos por IP y cuenta. La confirmación devuelve `REACTIVATED`; no emite sesión ni recupera permisos administrativos. El usuario inicia sesión de nuevo. No permite recuperar cuentas suprimidas ni levantar suspensiones.

## Continuidad y seguridad administrativa

- `POST /api/municipalities/{tenantId}/administrators/{accountId}/make-indefinite`, con `reason`, convierte un permiso temporal vigente ya aceptado en indefinido. Solo puede hacerlo un administrador con permiso indefinido, y nunca sobre su propio permiso. La revocación ordinaria exige otro responsable habilitado indefinido.
- `POST /api/municipalities/{tenantId}/accounts/{accountId}/revoke-access-for-security`, con `reason`, retira permisos e invitaciones pendientes solo en ese municipio, incluso los del último administrador. Requiere administrador municipal con MFA reciente.
- `POST /api/municipalities/{tenantId}/administrator-recovery-invitations` recibe `accountId`, `expiresAt`, `reason` y `verificationReference`. Un operador con MFA reciente invita a un sustituto únicamente si el municipio inicializado no tiene administradores habilitados. La referencia identifica la verificación externa de autoridad; no la realiza automáticamente. El destinatario acepta con MFA.
- `POST /api/platform/accounts/{accountId}/suspend`, con `reason`, exige operador y MFA reciente. Suspende la cuenta global, revoca sesiones y autoridad propia, incluso la del último operador, sin cancelar reservas. Un administrador municipal no puede utilizar esta operación por su rol municipal.

Una cuenta habilitada está activa, tiene correo verificado y MFA configurado; no necesita mantener una sesión abierta. No se puede deshabilitar MFA conservando permisos administrativos vigentes. Los permisos retirados no se restauran automáticamente.

## Gestores municipales

`POST /api/municipalities/{tenantId}/manager-invitations` recibe `accountId`, `expiresAt`, `roleExpiresAt` opcional y `permissions: [{ operation, unitId }]`. El administrador invita; el destinatario acepta con MFA mediante `/{invitationId}/accept`. `/{invitationId}/revoke` revoca la invitación o concesión con `{ "reason": "..." }`.

`GET /api/me/manager-invitations` devuelve las invitaciones y concesiones de la cuenta autenticada, con sus permisos y estado. Devuelve hasta 20 elementos y `nextCursor`; la página siguiente utiliza `?after=...`. No admite consultas de otra cuenta.

Para sustituir una concesión, la nueva invitación incluye `replacesInvitationId` y `reason`. La concesión anterior permanece activa hasta la aceptación: esta activa los nuevos permisos y revoca los anteriores en una sola transacción auditada. Las demás concesiones independientes no cambian. Si es necesario retirar acceso inmediatamente, se utiliza la revocación; no se espera a la aceptación de una sustitución.

`GET /api/municipalities/{tenantId}/manager-invitations` permite al administrador con MFA reciente consultar las invitaciones y concesiones del municipio. Incluye destinatario, emisor, permisos, referencia de sustitución y fechas de vencimiento, aceptación y revocación. Devuelve hasta 20 elementos y `nextCursor`; la página siguiente utiliza `?after=...`. Las fechas describen el historial y no sustituyen la comprobación de autoridad vigente de cada operación.

Cada permiso se limita a una operación y unidad real del municipio; `unitId: null` abarca el municipio. Las operaciones admitidas son `CATALOG_CREATE`, `CATALOG_MANAGE`, `RESERVATION_READ`, `RESERVATION_MANAGE`, `UNIT_BLOCK`, `REPORT_READ`, `DATA_EXPORT`, `PRIVACY_READ` y `PRIVACY_EXECUTE`. `CATALOG_CREATE` y los permisos de privacidad exigen ámbito municipal. Ninguna concede administración de la identidad global ni acceso a otros municipios.

## Catálogo en borrador

`POST /api/municipalities/{tenantId}/facilities` crea una instalación; `POST /api/municipalities/{tenantId}/facilities/{facilityId}/units` crea una unidad. Ambos reciben `{ "name": "..." }`, requieren el permiso municipal `CATALOG_CREATE` y MFA reciente y registran auditoría. Las altas persisten como borradores: no publican recursos ni permiten reservarlos. Estas rutas y `POST /api/municipalities` aceptan `Idempotency-Key`: misma clave y contenido normalizado recuperan el recurso original tras comprobar los permisos actuales; distinto contenido devuelve `IDEMPOTENCY_KEY_REUSED`. Omitir el encabezado representa una solicitud nueva. La interfaz siempre envía una clave y permite recuperar expresamente una respuesta incierta.

`GET /api/municipalities/{tenantId}/facilities/{id}` y `GET /api/municipalities/{tenantId}/units/{id}` consultan un recurso para mantenimiento. `PATCH` sobre esas mismas rutas recibe `{ "name": "..." }` y registra el nombre anterior y el nuevo en la misma transacción. Requieren `CATALOG_MANAGE` y MFA reciente: ámbito municipal para instalaciones, municipal o de la unidad concreta para unidades. No permiten cambiar identificadores ni trasladar unidades entre instalaciones o municipios. Si falla la auditoría, el cambio se revierte.

`PUT /api/municipalities/{tenantId}/facilities/{id}/profile` y `/units/{id}/profile` sustituyen la ficha pública completa: instalaciones con `address`, `postalCode`, `location`, `description`, `accessibility` y `contact`; unidades con `kind`, `indoor`, `capacity` y `description`. Los textos llevan variantes `gl` y `es`; un campo ausente se borra. Exigen `CATALOG_MANAGE` sobre el recurso, MFA reciente y `expectedVersion` igual a `profileVersion` (la lectura administrativa lo devuelve); una versión distinta responde `409`. Cada cambio guarda el estado anterior y el nuevo.

`GET /api/municipalities/{tenantId}/facilities` y `GET /api/municipalities/{tenantId}/units` listan los recursos visibles para la cuenta con MFA reciente. Devuelven hasta 20 elementos y `nextCursor`; la página siguiente utiliza `?after=...`. RLS filtra antes de paginar: un gestor limitado a determinadas unidades no obtiene las restantes ni acceso municipal a instalaciones. Sin recursos autorizados, la respuesta es una lista vacía. Estos listados son administrativos, no publicaciones del catálogo público.

`POST /api/municipalities/{tenantId}/facilities/{id}/withdraw` y la ruta equivalente `/units/{id}/withdraw` reciben `{ "reason": "..." }`. Registran la retirada y su motivo sin eliminar el recurso. Repetir la retirada devuelve el mismo instante sin duplicar el evento. Las consultas administrativas incluyen `withdrawnAt`; `null` indica que no se ha retirado, no que esté publicado. Una instalación retirada conserva sus unidades y no admite nuevas altas. Las reservas comprueban la retirada de la unidad y de su instalación.

## Calendarios de unidades

`PUT /api/municipalities/{tenantId}/units/{unitId}/calendar` recibe `expectedVersion`, `reason` y `calendar`. La primera configuración usa `expectedVersion: 0`; las siguientes deben indicar la versión actual o reciben `409 CONFLICT`. Cada versión conserva configuración, autor, motivo e instante; el rol web no puede modificarla ni eliminarla. Requiere `CATALOG_MANAGE` sobre la unidad y MFA reciente.

`calendar` contiene `minimumMinutes`, `maximumMinutes`, `stepMinutes`, `advanceDays`, `weekly` y `exceptions`. Las duraciones son múltiplos positivos del paso. `advanceDays: null` hereda el límite municipal; un valor explícito solo puede reducirlo. Los horarios usan días ISO 1–7 y minutos locales desde medianoche: `{ day, startMinute, endMinute }`. El final puede ser 1440; un intervalo que cruza medianoche se divide entre dos días. Las excepciones `{ date, intervals }` sustituyen el horario semanal de esa fecha; `intervals: []` representa cierre. Las fechas civiles admiten años `0001–9999`. Se rechazan fechas inválidas, duplicados y solapes.

`GET` sobre la misma ruta devuelve la versión actual; `?version=N` recupera una versión histórica. Guardar un calendario no publica la unidad. El guardado rechaza horarios o excepciones que dejen sin cobertura una reserva confirmada pendiente de finalizar, incluidas las que están en curso. La comprobación y el cambio de versión comparten una transacción SERIALIZABLE. Las reservas conservan sus condiciones aceptadas de duración y antelación; las nuevas reglas no reescriben su historial.

## Publicación del catálogo

`POST /api/municipalities/{tenantId}/facilities/{id}/publish` recibe `{ "reason": "..." }`. Para una unidad, `/units/{id}/publish` exige además `calendarVersion` e `independenceConfirmed: true`. La instalación debe estar publicada y no retirada; el calendario indicado debe ser el actual y superar la validación de reglas. La unidad necesita normas vigentes con contenido; si faltan, devuelve `409 USAGE_RULES_REQUIRED`: «Añade las normas de uso para publicar esta unidad». La confirmación de independencia física queda auditada con el actor y la versión: no es una detección automática de espacios solapados.

Publicar elimina la retirada del recurso indicado, sin borrar historial. Republicar una instalación habilita sus unidades previamente publicadas, no retiradas y con normas válidas. Los cambios no alteran las reservas existentes. Las unidades anteriores publicadas sin normas se ocultan del catálogo y de la disponibilidad hasta completarlas; se conserva `publishedAt`, sin crear normas ni aceptaciones ficticias.

## Normas y política de reserva

`PUT /api/municipalities/{tenantId}/units/{unitId}/usage-rules` recibe `expectedVersion`, `text` y `reason`. Requiere `CATALOG_MANAGE` sobre la unidad y MFA reciente. El texto es plano, no vacío y de hasta 20.000 caracteres. `expectedVersion: 0` crea la primera versión; una versión obsoleta devuelve `409`. Cada versión conserva texto, autor, fecha, motivo y correlación. `GET` devuelve la actual; `?version=N`, una histórica. Los roles de ejecución no pueden sobrescribirlas ni eliminarlas.

`GET` y `PUT /api/municipalities/{tenantId}/booking-policy` requieren administrador municipal y MFA reciente. El cambio recibe `expectedVersion`, `advanceDays`, `cancellationMinutes` y `reason`; incrementa la versión y conserva auditoría. No puede reducir la antelación municipal por debajo de un límite explícito vigente de una unidad. Los municipios nuevos parten de 30 días de antelación y 1.440 minutos de cancelación; las actualizaciones conservan las configuraciones existentes. Cambiar la política no modifica el plazo ya aceptado de las reservas.

## Tiempo civil y zonas IANA

La conversión usa `@js-temporal/polyfill` 0.5.1: Node 24.21.0 no expone Temporal en el entorno verificado. La dependencia evita mantener reglas de conversión horaria propias. Los modos `earlier` y `later`, comprobados mediante conversión de vuelta a hora local, permiten descartar horas inexistentes y conservar ambas ocurrencias de una hora repetida. Cada instante conserva UTC, fecha/hora local, desplazamiento y zona. La antelación compara fechas locales, no bloques de 24 horas. [Modelo temporal y ambigüedad](https://tc39.es/proposal-temporal/docs/timezone.html), [polyfill](https://github.com/js-temporal/temporal-polyfill).

Las pruebas incluyen Madrid, transiciones de media hora en Lord Howe y una fecha completa omitida en Apia. Los intervalos de apertura se intersectan con cada tramo de desplazamiento constante del día. Así, dos aperturas de una hora repetida permanecen separadas si existe un cierre real entre ellas; una jornada completa puede representar 23 o 25 horas reales. La generación de franjas aplica duración real, paso y antelación: los inicios se alinean con el comienzo de cada apertura civil continua y la duración se mide entre instantes UTC. Cada reserva candidata debe quedar íntegramente cubierta por apertura, incluso al cruzar medianoche. Una excepción del día siguiente puede impedir ese cruce. La API pública descarta las franjas que solapan ocupaciones no liberadas de reservas o bloqueos. La revisión completa de licencias y atribuciones sigue pendiente; el polyfill declara ISC y su dependencia JSBI, Apache-2.0.

## Catálogo y disponibilidad públicos

Sin sesión, bajo `/api/public/municipalities/{tenantId}`:

- `GET /booking-durations`: duraciones admitidas por alguna unidad publicada, con `recommended`, la que admiten más unidades; en caso de empate, la más corta.
- `GET /availability-search?date=AAAA-MM-DD&durationMinutes=N`: unidades con franjas libres, recorridas por páginas; `facilityId` limita la búsqueda a una instalación. Una página vacía con `nextCursor` no indica que se haya agotado el catálogo.
- `GET /facilities`: instalaciones publicadas con `units`, el número de unidades que se pueden reservar, y su `profile`, hasta 20 por página; `?after=nextCursor` continúa el listado.
- `GET /facilities/{facilityId}/units`: unidades publicadas de una instalación publicada y no retirada, con `minimumMinutes` y `maximumMinutes` de su calendario vigente y la misma paginación.
- `GET /units/{unitId}`: nombre, instalación, `profile` del espacio y `facilityProfile`, zona, límites, calendario, `usageRulesVersion` y `bookingPolicyVersion`, sin datos de auditoría.
- `GET /units/{unitId}/usage-rules`: texto plano y versión de las normas vigentes, sin autor ni motivo internos.
- `GET /units/{unitId}/availability?date=AAAA-MM-DD&durationMinutes=N`: franjas libres con UTC, hora local, desplazamientos, versión y momento de cálculo.

Estas consultas no crean cuentas ni perfiles. Los recursos no publicados o retirados no aparecen. Las unidades sin normas válidas tampoco se ofrecen; su detalle responde `404`. La disponibilidad lee calendario y ocupaciones en una misma transacción y descarta cualquier solape con una ocupación no liberada. Solo expone franjas, no titulares, identificadores de reservas ni motivos de bloqueos. Consultar no garantiza ni confirma una reserva. Las rutas públicas comparten un límite de 60 peticiones por 60 segundos y dirección reconocida por Fastify, incluso entre réplicas. Al superarlo devuelven `429 RATE_LIMITED` y `Retry-After`, antes de validar parámetros o calcular franjas. No confían en cabeceras de proxy enviadas por el cliente. PostgreSQL conserva una huella HMAC con clave compartida, no la IP en claro; cada petición elimina hasta 100 contadores cuya ventana tiene más de diez minutos. Sin tráfico, la limpieza se reanuda en la próxima petición; no constituye una garantía de borrado exactamente a los diez minutos. Las réplicas deben compartir `AUTH_SECRET`; rotarlo también reinicia la identidad de estos contadores.

## Textos legales

`GET /api/public/notices/{kind}` y `GET /api/public/municipalities/{tenantId}/notices/{kind}` devuelven el último texto publicado de la instancia o del municipio (`kind`: `privacy`, `legal` o `accessibility`). Con `version` 0 y `body` vacío todavía no hay texto. `PUT /api/municipalities/{tenantId}/notices/{kind}` (administrador) y `PUT /api/platform/notices/{kind}` (operador) publican una versión nueva con `{ "expectedVersion": N, "body": { "gl": {…}, "es": {…} } }`; exigen MFA reciente y una versión distinta devuelve `409`. Los campos admitidos por tipo están en la descripción OpenAPI. Las versiones se guardan sin posibilidad de modificarlas ni borrarlas.

## Portabilidad y calendario personal

`GET /api/municipalities/{tenantId}/exports/catalog` (administrador, MFA reciente) devuelve el JSON `quenda.catalog` v1: ajustes del municipio, instalaciones y espacios con su ficha, calendario y normas vigentes y estado de publicación. No contiene reservas ni datos personales; su esquema y su ejemplo están en la respuesta OpenAPI. Es una copia de lectura para archivo o traslado manual: la importación de archivos sigue fuera de alcance.

`GET /api/municipalities/{tenantId}/exports/reservations` admite `format=csv`: una fila por reserva (columnas en `reservationCsvColumns`), RFC 4180, UTF-8 con marca de orden de bytes y las celdas que empiezan por `=`, `+`, `-`, `@` o tabulación precedidas de `'`. Los textos largos de normas quedan solo en el JSON.

`GET /api/municipalities/{tenantId}/reservations/{reservationId}/calendar.ics` y `GET /api/me/reservations/calendar.ics` devuelven archivos iCalendar (RFC 5545) de una reserva del titular, en cualquier estado, o de sus próximas reservas confirmadas (hasta 100). Las horas van en UTC; el `UID` es estable, `SEQUENCE` es la revisión y una cancelación lleva `STATUS:CANCELLED`, de modo que volver a importar actualiza el evento. `lang=es|gl` fija el idioma del texto; sin él se usa `Accept-Language`. Son descargas puntuales.

Para que el calendario se actualice solo, el titular crea una suscripción desde «Mis reservas» (`POST /api/me/calendar-subscription`, con `Origin` autorizado). La respuesta trae, una única vez, `url` y `webcalUrl`: `GET /api/calendars/{secreto}.ics` devuelve sin sesión las próximas reservas confirmadas de la cuenta (hasta 100), con la misma identidad y revisión que las descargas; una reserva cancelada o finalizada desaparece del calendario. El secreto son 32 bytes aleatorios y la base guarda solo su SHA-256, así que una copia de la base no permite reconstruir la URL. Crear de nuevo sustituye el secreto; `POST /api/me/calendar-subscription/revoke` lo retira, y la baja, la suspensión o la supresión de la cuenta también, sin que una reactivación lo recupere. Una URL desconocida o retirada responde `404`. El límite es de 60 peticiones por minuto por URL, porque las aplicaciones de calendario consultan desde direcciones compartidas; las URL desconocidas cuentan además contra la dirección de origen. La imagen web no registra en su log estas rutas. Quien tenga la URL ve esas reservas: la interfaz lo advierte y no vuelve a mostrarla.

## Consulta de reservas

- `GET /api/municipalities/{tenantId}/reservations/{reservationId}`: estado actual de una reserva. Admite al titular sin MFA y al personal con permisos vigentes sobre la unidad y MFA. Un identificador de otro municipio o fuera del ámbito autorizado no revela la reserva.
- `GET /api/me/reservations`: historial del usuario autenticado entre municipios de la instancia, incluidas reservas de unidades retiradas. Devuelve nombre municipal y de unidad, sin aceptar un identificador de otro usuario.
- `GET /api/municipalities/{tenantId}/reservations`: requiere MFA y devuelve únicamente reservas cubiertas por `RESERVATION_READ` o `RESERVATION_MANAGE`. `?unitId=UUID` filtra sin ampliar permisos. `?date=AAAA-MM-DD` selecciona las reservas que se solapan con ese día municipal antes de paginar, incluidas las canceladas. Ser titular de una reserva no concede acceso al listado de gestión.

Los listados devuelven `{ items, nextCursor }`, con hasta 20 elementos y `Cache-Control: no-store`. `?after=nextCursor` continúa el listado. El historial propio se ordena del inicio más reciente al más antiguo y su cursor combina inicio, reserva y municipio. El listado municipal y el de bloqueos se ordenan por inicio, del más temprano al más tardío; su cursor es el identificador del último elemento. Los permisos se vuelven a comprobar en cada página.

El detalle no devuelve el resultado histórico de un comando: tras cancelar, muestra `CANCELADA` y la nueva revisión, aunque repetir la clave de creación siga recuperando la confirmación original.

Las consultas muestran `FINALIZADA` cuando el fin de una reserva confirmada es anterior o igual al instante de consulta. No modifican el estado almacenado ni ejecutan tareas programadas; una reserva cancelada sigue mostrando `CANCELADA`.

Las condiciones distinguen la referencia de normas aceptadas de las normas asignadas pendientes tras una reubicación. La evidencia anterior conserva unidad, versión e instante, aunque corresponda a otro destino. Los datos nulos significan «sin aceptación registrada», no otro estado de reserva. La aceptación pendiente tampoco cambia `CONFIRMADA` ni libera ocupación o cuota. Consultar o cancelar no exige aceptar normas.

## Confirmación de reservas

`POST /api/municipalities/{tenantId}/reservations` requiere sesión verificada, `Origin` autorizado y cabecera `Idempotency-Key` (1–200 caracteres alfanuméricos, `.`, `_`, `:`, `-`). El cuerpo contiene `unitId`, `startsAt`, `endsAt` y `acceptance: { usageRulesVersion, bookingPolicyVersion, nonCancellable }`. Los instantes son ISO con zona; el titular siempre es el usuario autenticado.

Enviar `acceptance` expresa la aceptación de esas versiones. `nonCancellable` debe ser `true` cuando la confirmación queda después de `inicio − plazo vigente`, y `false` en caso contrario. Las versiones proceden del detalle público de la unidad y su texto de normas. Si alguna cambia o se cruza el plazo durante la operación, devuelve `409 CONDITIONS_CHANGED` sin sustituir la aceptación ni guardar efectos. En el alta, `acceptance` solo puede omitirse para recuperar un comando anterior sin aceptación cuyo resultado siga retenido. Una creación nueva sin aceptación devuelve `409 CONDITIONS_ACCEPTANCE_REQUIRED`, igual que una modificación que necesita nueva aceptación y no la incluye.

La respuesta `201` contiene la reserva y sus condiciones aceptadas. Repetir la misma clave y contenido devuelve el resultado original, también con `201`; cambiar el contenido devuelve `409`. Las cabeceras `Idempotency-Replayed` e `Idempotency-Expires-At` indican recuperación y vencimiento. `Idempotency-Retention-Seconds` publica la configuración para comandos nuevos: `IDEMPOTENCY_RETENTION_SECONDS`, 86.400 segundos por defecto. El vencimiento ya guardado no cambia al repetir una petición ni al cambiar esa configuración. Una clave caducada puede ejecutar un comando nuevo; no debe reutilizarse para recuperar resultados fuera de su ventana.

`GET /api/public/reservation-command-policy` devuelve `retentionSeconds` y `serverTime`, sin caché. El cliente obtiene la ventana de recuperación antes de enviar un comando y vuelve a comprobarla antes de repetir un resultado incierto. Fuera de esa ventana, consulta el estado actual en vez de reenviar la clave caducada.

La creación valida las reglas vigentes y confirma reserva, ocupación, evento, avisos y resultado idempotente en una sola transacción. Los rechazos distinguen `SLOT_UNAVAILABLE`, `BOOKING_RULES_CHANGED`, `QUOTA_EXCEEDED`, `CREDENTIAL_REQUIRED` y `AGREEMENT_UNAVAILABLE`; solo el primero significa franja ocupada. Una revisión obsoleta devuelve `RESERVATION_CHANGED` ; modificar, aceptar normas o consultar disponibilidad de una reserva cancelada devuelve `RESERVATION_CANCELLED`. La cancelación repetida conserva su comportamiento idempotente. Los códigos de aceptación conservan sus condiciones específicas. Un conflicto no deja cambios parciales. El correo queda pendiente para su entrega por el worker. La disponibilidad pública descuenta las ocupaciones confirmadas, pero no garantiza que una franja siga libre al reservar.

## Modificación de reservas

Con sesión del titular, `GET /api/municipalities/{tenantId}/reservations/{reservationId}/availability?unitId=UUID&date=AAAA-MM-DD&durationMinutes=N` calcula franjas para una modificación dentro del plazo aceptado. Excluye solo la ocupación de esa reserva, mantiene las demás reservas y bloqueos y exige una unidad pública del mismo municipio. Consultar no libera ni garantiza la franja. Con `administrative=true`, exige `RESERVATION_MANAGE` en origen y destino y MFA reciente. Permite consultar antes del inicio sin aplicar el plazo ciudadano; no concede permiso para aceptar normas por el titular.

`POST /api/municipalities/{tenantId}/reservations/{reservationId}/modify` recibe `expectedRevision`, `unitId`, `startsAt` y `endsAt`, con la misma autenticación e idempotencia que la confirmación. Devuelve `200`. No cambia el titular ni el municipio.

La modificación del titular aplica el plazo aceptado de origen y las reglas vigentes del destino. `acceptance` solo puede omitirse si existe evidencia anterior de la misma unidad y versiones y cubre la condición de cancelación del nuevo intervalo. Una modificación real del titular sin esa evidencia exige aceptación fechada en ese cambio, no en la creación original.

Sustituye la ocupación, conserva la anterior liberada y registra las condiciones anteriores y nuevas. Un conflicto revierte todos los cambios. Una petición sin cambios de unidad o intervalo conserva versión y condiciones y no genera aceptación, evento ni aviso nuevos.

`administrative: true` exige `reason`, MFA reciente y `RESERVATION_MANAGE` sobre origen y destino. Permite cambiar fecha, horario o unidad dentro del municipio antes del inicio, incluso fuera del plazo ordinario del titular. Libera el origen, ocupa el destino y recalcula la cuota en una transacción; no mantiene dos reservas ni crea una propuesta. Conserva el plazo de cancelación aceptado, aplicado al nuevo inicio.

El gestor no envía `acceptance` por el titular. Si las normas del destino no están cubiertas por una aceptación de esa unidad y versión, el cambio queda realizado con aceptación pendiente y genera un aviso que lo indica. La misma regla se aplica a reservas históricas sin evidencia: se permite la modificación administrativa sin atribuirles una aceptación anterior.

## Aceptación de normas después de una reubicación

`POST /api/municipalities/{tenantId}/reservations/{reservationId}/accept-usage-rules` recibe `expectedRevision`, `unitId` y `usageRulesVersion`, con sesión, origen autorizado e `Idempotency-Key`. Solo puede ejecutarlo el titular. El detalle de la reserva identifica la versión asignada mediante `pendingUsageRulesVersion` y devuelve su texto en `pendingUsageRulesText`.

El titular consulta las normas exactas asignadas a la reserva y las acepta antes del nuevo inicio. Puede hacerlo dentro de las últimas 24 horas: aceptar no vuelve a modificar la reserva ni altera el plazo de cancelación. Solo registra su aceptación e incrementa la revisión, sin mover ocupación o cuota ni generar otro aviso de reprogramación.

La petición debe identificar la revisión, unidad y versión pendientes. Se rechaza si la reserva cambió concurrentemente. Publicar después otra versión del catálogo no reemplaza las normas ya asignadas a esa reserva; el gestor tampoco puede aceptarlas en nombre del usuario. El evento `NORMAS_ACEPTADAS` registra la nueva evidencia y elimina la referencia pendiente. No crea un aviso interno ni un correo.

Sin respuesta, la reserva reubicada permanece confirmada, ocupada y con su cuota consumida. No se revierte ni cancela automáticamente. La falta de aceptación sigue visible al llegar el inicio, sin inferir asistencia ni generar una incidencia. Ante una discrepancia, el titular contacta directamente con el municipio. La aplicación informa del requisito de aceptación antes del uso; no controla físicamente el acceso a la instalación.

## Cancelación de reservas

`POST /api/municipalities/{tenantId}/reservations/{reservationId}/cancel` recibe `expectedRevision` y utiliza la misma sesión, protección de origen e idempotencia que la confirmación. Devuelve `200` con el estado cancelado. Una reserva ya cancelada no genera otro evento ni otro aviso, aunque se use una clave nueva.

El titular cancela con `ahora ≤ inicio − plazo aceptado` y siempre `ahora < inicio`. Los municipios nuevos tienen 24 horas por defecto, configurables. El plazo se comprueba en servidor, también después de esperar bloqueos; su rechazo devuelve `409 RESERVATION_DEADLINE_PASSED` sin liberar ocupación ni cuota. No permite modificar para eludirlo. Cancelar nunca exige aceptar normas nuevas.

`administrative: true` exige permiso `RESERVATION_MANAGE`, MFA reciente y `reason`; permite omitir el plazo del titular, pero nunca cancelar una reserva ya iniciada. Una versión obsoleta produce `409`. Reserva, liberación de ocupación y cuota, evento y avisos se confirman juntos. La autorización se comprueba también al recuperar un resultado idempotente.

Una reserva de última hora exige aceptar que no puede cancelarse por cuenta propia. Ante una excepción, el usuario contacta directamente con el municipio; no se crea un ticket. El titular conserva su responsabilidad y puede reorganizar participantes según las normas, sin transferir la reserva. La ausencia conserva tiempo reservado e historial, sin inferir asistencia ni generar automáticamente incidencias o penalizaciones.

## Bloqueos de unidades

`GET /api/municipalities/{tenantId}/agenda/units` devuelve identificador y nombre de las unidades con `RESERVATION_READ`, `RESERVATION_MANAGE` o `UNIT_BLOCK`, incluidas las retiradas. Exige MFA y no concede permisos de catálogo. Devuelve páginas de 20 y `nextCursor`; `after` continúa la consulta.

`GET /api/municipalities/{tenantId}/blocks` devuelve los bloqueos autorizados por `UNIT_BLOCK`, incluidos los liberados, con MFA reciente. Admite `date`, `unitId` y `after`; el filtro de día utiliza la zona municipal antes de paginar. No expone motivos de bloqueos ajenos.

`POST /api/municipalities/{tenantId}/blocks` recibe `unitId`, `startsAt`, `endsAt` y `reason`. Exige `UNIT_BLOCK` sobre la unidad, MFA reciente, origen autorizado e `Idempotency-Key`; devuelve `201`. Los intervalos deben ser finitos y ordenados, sin aplicar al mantenimiento las reglas de duración o antelación de una reserva. Un solape con una reserva o bloqueo no liberado produce `409` sin cambios parciales. Las reservas afectadas deben resolverse mediante operaciones explícitas.

`POST /api/municipalities/{tenantId}/blocks/{blockId}/release` recibe un nuevo `reason` y devuelve `200`. Libera la ocupación y conserva el bloqueo y su motivo original; registra el motivo de retirada en un evento inmutable. Repetir la retirada no genera otro evento. Ambas operaciones son idempotentes y comprueban permisos antes de recuperar resultados. La disponibilidad pública refleja sus efectos tras el commit.

## Integridad de reservas y bloqueos

PostgreSQL mantiene una ocupación activa por reserva confirmada o bloqueo vigente. Una exclusión temporal compartida impide solapes en la misma unidad y municipio; los intervalos son semiabiertos `[inicio, fin)`, por lo que admiten reservas consecutivas. Las claves compuestas impiden referencias entre municipios.

Las restricciones diferidas comprueban al confirmar la transacción que la unidad y el intervalo de la ocupación coinciden con su origen. Cancelar una reserva o liberar un bloqueo exige liberar su ocupación en la misma transacción. Cambiar una reserva sustituye la ocupación sin borrar la anterior; un conflicto revierte todos los cambios. Los permisos SQL y RLS restringen la lectura y modificación al contexto autorizado.

La confirmación HTTP utiliza estas garantías. Los cambios de calendario incompatibles requieren resolver antes las reservas afectadas mediante operaciones explícitas.

## Gestión de operadores

`POST /api/platform/operator-invitations` invita a una cuenta verificada con `accountId` y `expiresAt`. `GET` sobre la misma ruta lista las invitaciones para operadores autorizados. El destinatario consulta `GET /api/me/operator-invitations` y acepta mediante `POST /api/platform/operator-invitations/{invitationId}/accept`, con MFA reciente. `POST /api/platform/operator-invitations/{invitationId}/revoke` y `POST /api/platform/operators/{accountId}/revoke` requieren `reason`. `GET /api/platform/operators` lista los responsables. La retirada ordinaria no puede dejar la plataforma sin operador habilitado; el permiso no caduca automáticamente.

La recuperación excepcional usa la credencial separada de mantenimiento y exige una verificación externa documentada:

```sh
pnpm operator:recover ACCOUNT_ID PERFORMED_BY AUTHORITY_REFERENCE REASON
pnpm account:recover ACCOUNT_ID PERFORMED_BY IDENTITY_REFERENCE REMEDIATION_REFERENCE REASON
```

`operator:recover` solo actúa después de la inicialización y cuando no quedan operadores habilitados. La cuenta destinataria debe estar activa, verificada y tener MFA. `account:recover` recupera únicamente acceso personal de una cuenta conservada e inactiva; no genera sesiones ni recupera roles. Antes de levantar una suspensión deben sustituirse las credenciales comprometidas mediante el procedimiento controlado: contraseña, secreto MFA y códigos de respaldo si existían. El backend comprueba que sus registros hayan cambiado; la verificación operativa debe acreditar que son credenciales realmente nuevas y controladas por el titular. No se introducen contraseñas, secretos ni documentos completos en argumentos, referencias o registros de auditoría.

## Primer operador

Crear y verificar una cuenta por la API y completar el alta de TOTP antes de inicializar el operador. Con su identificador de cuenta y las credenciales de mantenimiento:

```sh
pnpm operator:initialize IDENTIFICADOR_DE_CUENTA
```

La operación registra una única inicialización auditable. Rechaza cuentas sin correo verificado o MFA y no puede repetirse aunque el operador se revoque. El proceso web no puede modificar directamente las tablas de operadores: utiliza funciones restringidas, autorizadas y auditadas. Este permiso operativo no concede acceso general a datos municipales.

## Auditoría de rechazos

Los rechazos de operaciones propias posteriores a la autenticación se registran en una transacción independiente, incluso si el comando revierte. El registro contiene actor verificado, identificador de petición generado por el servidor, municipio solicitado, operación, resultado e instante. El municipio solicitado no acredita pertenencia ni existencia. No incluye contenido de formularios, cookies ni identificadores de sesión. El rol web solo puede añadir registros asociados al actor transaccional; no puede leerlos, modificarlos ni eliminarlos.

Los rechazos anteriores a la autenticación quedan en el log estructurado sin atribuirles una cuenta. Si falla la persistencia de una auditoría autenticada, la API responde `503 UNAVAILABLE` y registra el fallo sin detalles SQL. Los eventos de operaciones aceptadas permanecen dentro de su transacción de negocio.

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

Los workflows están en [.github/workflows](.github/workflows) y se limitan a comprobaciones básicas de menos de cinco minutos en cada pull request y en cada cambio incorporado a `main`:

| Comprobación | Contenido |
|---|---|
| `Backend checks` | `pnpm check`, compilación, generación de OpenAPI y validación de sintaxis de la composición de referencia. |
| `Web checks` | Tipos, lint, pruebas unitarias y compilación del paquete estático. |

Los ejecutores utilizan Ubuntu 24.04, Node de `.nvmrc` y pnpm de `package.json`. La instalación respeta el lockfile y no ejecuta scripts de dependencias. Las acciones externas están fijadas por SHA, el token solo permite leer el repositorio y no se conserva en Git. No se utilizan secretos de aplicación, cachés compartidas, servicios reales ni credenciales cloud. La configuración no despliega servicios ni ejecuta Terraform. [Seguridad de GitHub Actions](https://docs.github.com/en/actions/reference/security/secure-use).

## Licencia

Quenda utiliza **AGPL-3.0-only**, no «or later». El [texto íntegro](LICENSE) se distribuye con el proyecto. Los despliegues sujetos a sus obligaciones deben facilitar el código fuente correspondiente; las versiones modificadas accesibles por red deben ofrecerlo a sus usuarios conforme a la sección 13. [Identificador SPDX y términos](https://spdx.org/licenses/AGPL-3.0-only.html).


## Colaboración, comunicaciones y operación

### Convenios: creación, versiones y aprobación

Los comandos requieren administrador del municipio participante, sesión verificada, MFA reciente, `Origin` autorizado e `Idempotency-Key`. Comprueban los permisos actuales antes de recuperar un resultado idempotente.

- `POST /api/municipalities/{tenantId}/agreements`: registra nombre, zona IANA, vigencia, finalidad, base jurídica, responsabilidades, conservación, elegibilidad, cuota opcional, capacidad de informes y participantes con sus unidades y condición de emisor. Devuelve `201` con `agreementId`, `version: 1` y `BORRADOR`.
- `POST /api/municipalities/{tenantId}/agreements/{agreementId}/versions`: recibe la configuración completa y `expectedVersion`, sin nombre ni zona. Devuelve `201` con la nueva versión `BORRADOR`; una versión base obsoleta produce `409`. Conserva las evidencias anteriores sin trasladar sus aprobaciones.
- `POST /api/municipalities/{tenantId}/agreements/{agreementId}/approve`: recibe `version` y el conjunto exacto `unitIds` del municipio. Devuelve `200`: `BORRADOR` mientras falten participantes y `APROBADO` cuando todos hayan aprobado. No admite nuevas aprobaciones de versiones superadas.

Las respuestas incluyen las cabeceras de idempotencia y `Cache-Control: no-store`. Un replay conserva el resultado original, no representa necesariamente el estado actual. Ninguno de estos comandos activa el convenio ni habilita capacidades de reserva.

- `GET /api/municipalities/{tenantId}/agreements`: lista las versiones visibles al administrador municipal con MFA reciente, en páginas de 20 y orden por convenio/versión. `after` acepta el `nextCursor` anterior; no identifica versiones efectivas.
- `GET /api/municipalities/{tenantId}/agreements/{agreementId}/versions/{version}`: devuelve configuración, participantes, unidades, aprobaciones y evidencia de creación. Una versión sin participación del municipio devuelve `404`, aunque haya participado en otra versión. Ambas consultas utilizan `Cache-Control: no-store`.

### Acreditaciones

- `POST /api/municipalities/{tenantId}/credentials`: recibe `agreementId`, `version`, `accountId`, `startsAt`, `endsAt` y `verificationReference`. Exige administrador con MFA reciente, municipio emisor habilitado, cuenta vinculada a ese municipio y versión activa dentro de su vigencia efectiva en modo `acreditacion_vigente`. Devuelve `201` con el identificador y `revoked: false`; no afirma elegibilidad para una reserva.
- `POST /api/municipalities/{tenantId}/credentials/{credentialId}/revoke`: recibe `reason`; exige administrador del municipio emisor con MFA reciente y devuelve `200` con `revoked: true`. Permite revocar aunque el convenio esté suspendido y conserva el primer motivo y la evidencia de emisión.

Ambos comandos requieren `Origin` autorizado e `Idempotency-Key`, devuelven cabeceras de idempotencia y `Cache-Control: no-store`, y revalidan permisos antes del replay. El listado solo muestra acreditaciones emitidas por el propio municipio; no existe un listado general ni una consulta libre de elegibilidad.

Las reservas de unidades adscritas comprueban, en su misma transacción, la vigencia efectiva del convenio, la acreditación que cubre todo el intervalo cuando se exige y la cuota semanal conjunta por cuenta. Crear atribuye el consumo; reprogramar recalcula semana y destino; cancelar lo libera. Una modificación sin cambios conserva la atribución. El rechazo revierte reserva, ocupación, consumo, auditoría y resultado idempotente; no devuelve consumos ni acreditaciones ajenas. La suspensión permite cancelar, pero impide nuevas reservas y reprogramaciones; cerrar la adscripción no activa el acceso público automáticamente.

`POST /api/municipalities/{tenantId}/agreements/{agreementId}/suspend` recibe `version` y `reason`. Un administrador participante con MFA reciente suspende el convenio completo y cierra sus vigencias efectivas, incluidas las programadas. El municipio debe participar en una versión en vigor o programada: quien solo participó en una versión ya sustituida o vencida recibe `409`. Conserva reservas, consumos y vinculaciones de unidades; registra actor, municipio, motivo y correlación. Devuelve `200` con `SUSPENDIDO`; repetir no duplica eventos. Exige `Origin` autorizado e `Idempotency-Key`. Un borrador o una versión únicamente aprobada no puede suspenderse mediante este comando.

`POST /api/municipalities/{tenantId}/agreements/{agreementId}/activate` activa una nueva versión aprobada, incluida la sustitución o reactivación. Recibe `version`, `legalReviewReference` y `reportReviewReference` (puede ser nula si no se habilitan informes). Exige la versión aprobada más reciente, aprobación de todos los participantes, unidades adscritas y emisor habilitado si se requieren acreditaciones. Concilia las reservas confirmadas de las unidades y vigencia aprobadas, conservándolas aunque superen la cuota o no cumplan la nueva elegibilidad. Devuelve `200` con `ACTIVADO`. La operación completa es idempotente y atómica; exige administrador participante, MFA reciente y `Origin` autorizado. Otra activación de la misma versión con una clave nueva devuelve `409`. Sustituir o reactivar exige una nueva versión y todas sus aprobaciones; cierra las vigencias anteriores sin solapes, conserva sus evidencias y no reinicia los consumos de cuota, tampoco al retirar unidades.

### Reapertura municipal de unidades

- `GET /api/municipalities/{tenantId}/units/{unitId}/agreement-restriction`: devuelve la vinculación persistente o `null`. `hasRemainingAssignment` indica si existen adscripciones actuales o programadas; no representa disponibilidad para reservar.
- `POST /api/municipalities/{tenantId}/units/{unitId}/agreement-restriction/release`: recibe `expectedAgreementId`, `expectedVersion` y `reason`. Retira la restricción únicamente si coincide la vinculación esperada y no quedan adscripciones actuales ni programadas. Conserva publicación, calendario, reservas y consumos; registra actor, motivo y correlación. Devuelve `removed: false` si ya no existe restricción.

Ambos endpoints exigen administrador municipal y MFA reciente. El comando exige `Origin` autorizado e `Idempotency-Key`; revalida permisos antes del replay. Retirar la restricción no publica la unidad ni libera ocupaciones.

### Avisos internos

`GET /api/me/notices` devuelve los avisos del usuario autenticado entre municipios, con `Cache-Control: no-store`. Pagina de 20 en 20 por identificador de evento y municipio; `after` acepta el `nextCursor` anterior. Cada aviso contiene tipo, revisión, fecha del evento e intervalo histórico, junto con `reservationPath` para consultar el estado actual. La reubicación administrativa indica si exige aceptar normas antes del uso. En intervenciones administrativas incluye el nombre capturado del autor y el motivo, además de la fecha del evento; los registros antiguos sin nombre capturado no se completan con el nombre actual. No expone identificadores del actor ni correlaciones, y no representa el estado de entrega del correo.

### Procesamiento de correo

`processReservationEmail` reclama un evento con el rol `quenda_worker`, confirma la concesión y envía mediante `MailTransport` fuera de la transacción. Registra aceptación, fallo o vencimiento del intento; los tokens vencidos no pueden confirmar resultados. Los eventos se procesan por reserva y revisión. Agotar los intentos conserva el evento y permite continuar con revisiones posteriores.

El rol worker ejecuta funciones acotadas de entrega de correo, estado de la cola y preparación de informes mensuales; no puede consultar directamente reservas, cuentas o intentos. El bootstrap de bases nuevas lo crea con credenciales independientes; `db:local:config` las guarda en `.env.worker.local`, separado del entorno web. Para una base creada antes de incorporar el worker, configurar `BOOTSTRAP_DATABASE_URL` y una contraseña nueva `WORKER_DATABASE_PASSWORD` de al menos 24 caracteres en `.env.bootstrap.local`; ejecutar `pnpm db:provision:worker` antes de aplicar las migraciones pendientes. El comando crea únicamente `quenda_worker`, concede conexión y uso del esquema `domain` y fija su `search_path`. Las migraciones conceden las funciones operativas. Falla si el rol ya existe o los esquemas no pertenecen al migrador; no reemplaza roles ni contraseñas. Configurar después `WORKER_DATABASE_URL` en el entorno exclusivo del worker. No repetir el bootstrap completo sobre una base existente.

La función recibe explícitamente origen, idioma, duración de concesión, máximo de intentos y espera de reintento. Sus resultados son `IDLE`, `ACCEPTED`, `RETRY_SCHEDULED`, `EXHAUSTED` y `LEASE_LOST`. `ACCEPTED` no garantiza recepción. Un envío aceptado cuyo resultado no llegue a registrarse puede repetirse tras vencer la concesión.

Para ejecutar el worker local: `pnpm worker:local`; añadir `--once` procesa como máximo un evento y termina. Tras `pnpm build`, `pnpm worker:start` ejecuta `dist/email-worker.js` con las variables del entorno. Requiere `WORKER_DATABASE_URL`, `AUTH_ORIGIN` y `EMAIL_LOCALE` (`gl` o `es`). La configuración generada usa gallego; este valor es del proceso, no una preferencia persistida del usuario.

Los parámetros opcionales son `EMAIL_LEASE_SECONDS` (60), `EMAIL_MAX_ATTEMPTS` (5), `EMAIL_RETRY_SECONDS` (60) y `EMAIL_POLL_MS` (1000). Reducir el máximo agota los pendientes que ya lo alcanzan. SIGINT/SIGTERM detienen nuevas iteraciones y cierran el pool tras el intento en curso. Los logs contienen códigos de estado, no destinatarios ni respuestas del proveedor. El transporte local no permite ejecutar el worker con `NODE_ENV=production`.

El worker publica `EMAIL_QUEUE_HEALTH` con cantidades de pendientes, concesiones y agotados al iniciar el procesamiento y, como máximo, una vez por minuto, salvo que un intento agote su límite. Emite `EMAIL_QUEUE_ATTENTION` cuando detecta un total no nulo de agotados distinto del último observado. La alerta también cubre agotamientos por concesión vencida o reducción del límite. Solo el rol worker puede consultar estos contadores; no incluyen identificadores ni destinatarios.

El mismo proceso ejecuta, como máximo una vez por minuto, un lote de conservación y la eliminación acotada de claves de idempotencia vencidas (`IDEMPOTENCY_PURGE`). Un fallo de estas tareas se registra como `RETENTION_BATCH_FAILED` o `IDEMPOTENCY_PURGE_FAILED` y no detiene el envío de correo; la barrera de restauración de privacidad sí detiene el worker.

### Idioma de avisos

`GET /api/me/preferences` consulta la preferencia de la cuenta autenticada. `PUT /api/me/preferences`, con `Origin` autorizado, recibe únicamente `{ "locale": "gl" }`, `{ "locale": "es" }` o `{ "locale": null }`. El valor nulo utiliza `EMAIL_LOCALE` del worker. No permite consultar ni modificar otra cuenta.

Cada correo guarda la preferencia del titular al generarse el evento, también cuando la operación la realiza personal municipal. Cambiar la preferencia no altera correos ya pendientes. El worker utiliza ese idioma guardado y solo recurre a su configuración cuando no existe una elección del titular.

### Transporte SMTP

Autenticación y worker utilizan la misma implementación de `MailTransport`. `MAIL_TRANSPORT=local` es el valor predeterminado de desarrollo; `MAIL_TRANSPORT=smtp` permite configurar un servidor sin depender de un proveedor concreto. En producción se exige SMTP y `AUTH_ORIGIN` HTTPS.

SMTP requiere `SMTP_HOST` y `SMTP_FROM` (una dirección). `SMTP_TLS=starttls` exige actualizar la conexión a TLS y usa el puerto 587 por defecto; `SMTP_TLS=tls` inicia con TLS y usa 465. `SMTP_PORT` permite otro puerto. `SMTP_USER` y `SMTP_PASSWORD` se proporcionan juntos cuando el servidor requiere autenticación. `SMTP_SERVERNAME` identifica el certificado y debe indicarse al conectar por IP; vacío utiliza `SMTP_HOST`. `SMTP_CA_FILE` permite una CA privada mediante una ruta dentro del proceso. Nunca se desactiva la validación del certificado ni se admite degradación a texto plano.

La composición transmite ambas variables a API y worker. Para montar una CA privada, definir `SMTP_CA_HOST_FILE` como ruta absoluta del certificado y añadir `-f compose.smtp-ca.example.yaml` después de `-f compose.production.example.yaml` en las operaciones Compose. El override monta el certificado de solo lectura en `/run/quenda/smtp-ca.pem` y configura `SMTP_CA_FILE` en ambos servicios.

Nodemailer 10.1.7 está fijado en el lockfile e incluye tipos TypeScript y licencia MIT-0. Se utiliza sin pool SMTP, sin logs de protocolo y sin acceso a archivos/URLs desde el contenido del mensaje. Los errores del proveedor se sustituyen por un error genérico. Las pruebas usan servidores SMTP temporales locales con TLS, STARTTLS, autenticación y rechazos; no envían mensajes externos. Configuración basada en la [documentación oficial de Nodemailer](https://nodemailer.com/smtp).

### Indicadores municipales y por unidad

`GET /api/municipalities/{tenantId}/units/{unitId}/indicators?from=2030-01-01&to=2030-02-01` exige `REPORT_READ` sobre la unidad y MFA. El periodo usa fechas locales `[from,to)`, con un máximo de 366 días. Devuelve conteos por estado, minutos reservados, minutos ofertados y porcentaje de ocupación (`null` cuando la oferta es cero), con zona e instante de consulta.

`GET /api/municipalities/{tenantId}/indicators` acepta el mismo periodo y exige `REPORT_READ` municipal y MFA. Incluye todas las unidades, aunque estén retiradas, en una misma transacción y con un único instante de consulta. Suma minutos antes de calcular el porcentaje; no promedia porcentajes por unidad. Un municipio sin unidades devuelve conteos y minutos cero, y porcentaje `null`. Los permisos limitados a unidades no habilitan este total municipal.

La oferta utiliza versiones de calendario y eventos históricos de publicación/retirada de instalación y unidad. Los cierres se recortan a su vigencia efectiva. Dos transiciones contradictorias de publicación con el mismo instante devuelven `409` en vez de inventar un orden. No se devuelven titulares, motivos ni eventos de auditoría. Las respuestas usan `Cache-Control: no-store`.

### Exportación de reservas

`GET /api/municipalities/{tenantId}/exports/reservations?from=2030-01-01&to=2030-02-01` descarga JSON `quenda.reservations`, versión 3. El parámetro opcional `unitId` limita el conjunto a una unidad. Exige `DATA_EXPORT` y `RESERVATION_READ` o `RESERVATION_MANAGE` para el mismo ámbito, con MFA de los últimos cinco minutos. Sin `unitId`, ambos permisos deben ser municipales.

El archivo identifica municipio, unidad solicitada (`null` para todo el municipio), instante de generación, periodo, zona horaria y entidades incluidas. Selecciona reservas que se solapan con `[from,to)` en la zona del municipio; conserva sus intervalos completos, aunque crucen una frontera del periodo. `usageRulesUnitId`, `usageRulesVersion` y `usageRulesText` identifican las normas aceptadas, que pueden corresponder a la unidad anterior. `pendingUsageRulesVersion` y `pendingUsageRulesText` identifican las normas pendientes de la unidad actual. Incluye instantes de aceptación, plazo conservado y `nonCancellableAccepted`; los nulos indican evidencia no registrada. `FINALIZADA` se calcula al generar el archivo y no acredita asistencia. Incluye el identificador del titular, como la consulta municipal ordinaria, pero no nombres, correos ni credenciales. No es una copia de seguridad de la base de datos.

Cada solicitud admite hasta 366 días y 10000 reservas. Si excede el límite, devuelve `400` sin archivo parcial: debe reducirse el periodo o seleccionar una unidad. La respuesta usa `Cache-Control: no-store` y descarga `quenda-reservations-v3.json`.

Esquema JSON Schema Draft 7 y ejemplo sintético, generados desde el mismo contrato usado por la API:

```sh
node scripts/export-schema.ts > /tmp/quenda-export-schema.json
node scripts/export-schema.ts --example > /tmp/quenda-export-example.json
```

Ambos archivos pueden validarse con herramientas independientes compatibles con Draft 7 y comprobación de formatos. El esquema valida la estructura; los permisos, el solape temporal y la pertenencia al municipio se comprueban en el sistema.

### Preparación de informes mensuales

```sh
pnpm reports:prepare <convenio-uuid> <AAAA-MM> <revision-actual>
# Con la aplicación compilada y WORKER_DATABASE_URL configurada:
node dist/monthly-report-worker.js <convenio-uuid> <AAAA-MM> <revision-actual>
```

El comando utiliza exclusivamente `quenda_worker`. No requiere configuración de correo ni credenciales del migrador. `revision-actual` es `0` para la primera evaluación; una corrección indica la revisión existente y crea la siguiente sin sobrescribirla. Una revisión obsoleta produce `CONFLICT` y código de salida `1`.

El mes debe estar cerrado en la zona del convenio. La evaluación usa su ámbito efectivo, incluye consumos aunque no exista cuota semanal y suprime las métricas si alguna contribución municipal no alcanza diez cuentas distintas. El máximo de procesamiento es 100000 consumos: superar el límite hace fallar la preparación, sin truncar el conjunto ni cambiar el periodo mensual.

La salida contiene únicamente convenio, mes, revisión y corte; no incluye métricas ni sujetos. La evaluación queda almacenada con acceso restringido. Prepararla no autoriza su publicación: la entrega exige las revisiones de riesgo correspondientes y deja constancia del destinatario y de la evaluación entregada.

### Revisión y entrega de informes mensuales

Base: `/api/municipalities/{tenantId}/agreements/{agreementId}/reports/{AAAA-MM}`.

- `GET /review-context?revision=1&recipientTenantId=…&recipientAccountId=…`: devuelve referencias y `historyDigest`, sin métricas ni historial individual. Exige administrador participante y MFA reciente.
- `POST /reviews`: registra `revision`, destinatario, `expectedHistoryDigest`, decisión `APPROVE`/`REJECT` y referencias `auxiliaryReference`, `ownDataReference`, `priorReleasesReference` y `correctionReference`. Esta última puede ser `null` solo en la primera revisión. Exige administrador, MFA reciente, Origin e `Idempotency-Key`.
- `GET` sobre la base: entrega el último informe autorizado al usuario autenticado, con `REPORT_READ` municipal y MFA. No admite filtros ni selección de revisiones. Registra la entrega en la misma transacción; si falla ese registro, no devuelve el informe.

Todas las respuestas usan `Cache-Control: no-store`. La entrega necesita capacidad vigente y revisiones favorables de todos los municipios participantes, vinculadas al destinatario, evaluación e información previamente entregada. Un nuevo rechazo impide entregas posteriores. Sin autorización de publicación, devuelve únicamente `{"status":"NOT_PUBLISHABLE"}`, sin métricas, ceros ni causas. Las referencias de revisión documentan la evaluación humana del riesgo; no certifican automáticamente anonimato.

### Auditoría de sesiones

`auth.session_event` registra creación y eliminación de sesiones y cambios de la prueba MFA en la misma transacción que la escritura. Conserva únicamente identificador de evento, cuenta afectada, operación e instante; no contiene identificadores de sesión, tokens, IP, agente de usuario ni correo. Los roles de ejecución no pueden consultarlo ni modificarlo directamente. Un fallo al registrar el evento revierte la escritura de sesión.

Son hechos de persistencia: crear una sesión no acredita por sí solo un inicio de sesión con MFA completo, y eliminarla no distingue cierre voluntario, revocación o limpieza. La cuenta afectada no se presenta como actor de la operación. El registro no sustituye la auditoría de intentos fallidos ni define una política de conservación.

`auth.credential_event` registra altas, cambios y retiradas de contraseñas, activación/desactivación MFA y cambios del material TOTP o de recuperación. Solo almacena cuenta afectada, operación, identificador e instante, con las mismas restricciones y atomicidad que los eventos de sesión. No conserva hashes ni valores anteriores o nuevos de los secretos. Un cambio del material de recuperación no distingue por sí solo regeneración de códigos y consumo de un código.

`auth.request_event` registra recepción y resultado HTTP de las operaciones de autenticación expuestas, correlacionados con `x-request-id` generado por el servidor. La operación procede de una lista cerrada; no se almacenan URL, consultas, cuerpos, cookies, errores del proveedor ni respuestas. En operaciones de sesión, el actor procede de una sesión verificada; los flujos públicos y desafíos MFA no se atribuyen al correo o cuenta indicados por el cliente.

`RETURNED` registra el estado HTTP, no acredita por sí solo autenticación completa. `THREW` indica que el proveedor lanzó una excepción. Una recepción sin evento terminal indica resultado no registrado. Si falla la recepción, el proveedor no se ejecuta; si falla el registro final, se devuelve 503 sin entregar la respuesta del proveedor, aunque este puede haber confirmado cambios. Los eventos transaccionales de sesión y credenciales permiten comprobar esos cambios; no se promete atomicidad entre Better Auth y el registro HTTP. Las consultas de sesión/esquema y los rechazos previos al despacho HTTP no generan este registro.

### Métricas de base de datos

La API emite `DATABASE_METRICS` cada 30 segundos mediante su logger (`info`). Para cada pool publica conexiones totales, libres y solicitudes en espera. Los contadores de `commands` cubren únicamente operaciones ejecutadas mediante `command`: iniciadas, activas, confirmadas, fallidas, reintentos, fallos de serialización e interbloqueos. Un fallo reintentado no cuenta como comando fallido si el intento posterior confirma.

La duración acumulada y máxima se expresan en milisegundos e incluyen espera de conexión y backoff del comando completo. Son acumulados locales que se reinician con el proceso, no percentiles ni métricas globales entre réplicas. Las consultas directas de Better Auth no pasan por este ejecutor. Los registros no llevan cuentas, municipios, SQL ni credenciales como etiquetas. El temporizador se elimina al cerrar la API y no mantiene vivo el proceso por sí solo.

`retryExhaustions` cuenta comandos que terminan tras agotar reintentos por serialización o interbloqueo. En cada muestreo, `DATABASE_RETRY_EXHAUSTED` (`warn`) informa del incremento y del total por pool. No repite el aviso si el contador no cambia ni lo activa por un rechazo funcional. La detección tiene la cadencia de 30 segundos; no sustituye un sistema externo de recepción de alertas.

### Imagen OCI

`pnpm image:build quenda-backend:local` construye una imagen común para API y workers desde una revisión Git limpia. El comando crea un archivo de fuentes, extrae de él el contexto de construcción e incorpora el mismo archivo a la imagen. La revisión queda registrada en la etiqueta OCI y la descarga se configura con su SHA-256. No usar un contexto manual distinto para el artefacto que se ofrece a los usuarios. `pnpm test:oci` verifica el artefacto local; `QUENDA_IMAGE` permite seleccionar otra etiqueta. La imagen fija Node y el digest de su base, instala con el lockfile y separa compilación de dependencias de producción. El contexto admite únicamente fuentes y archivos necesarios: no incluye `.env`, Git, datos locales ni credenciales. Ejecuta como `node`, sin compilador TypeScript ni herramientas de desarrollo. El digest debe revisarse al actualizar la base; fijarlo no incorpora automáticamente correcciones posteriores. [Recomendaciones de construcción de Docker](https://docs.docker.com/build/building/best-practices/).

El entrypoint es `node`; el comando predeterminado inicia `dist/server.js`. El mismo artefacto admite `dist/email-worker.js`, `dist/monthly-report-worker.js` y `scripts/migrate.ts`. Cada proceso recibe exclusivamente su configuración y credenciales; el proceso API no necesita la URL del migrador ni del worker. La imagen usa `NODE_ENV=production`: API y correo requieren la configuración SMTP y HTTPS ya descrita. No contiene datos de demo ni configura alojamiento.

Las pruebas OCI requieren Docker local y las imágenes oficiales referenciadas por digest. Crean una red interna efímera, sin publicar puertos, y dos bases PostgreSQL con credenciales aleatorias independientes. Ejecutan bootstrap/migraciones desde la imagen, verifican repetición de migraciones, catálogo de dos municipios en una instancia y uno en otra, rechazo de credenciales cruzadas, readiness durante caída/recuperación de PostgreSQL y persistencia tras reiniciar la API. El worker arranca con sus propias credenciales y procesa una cola vacía; esta prueba no verifica entrega SMTP ni sustituye las pruebas de correo. Los datos del catálogo son fixtures sintéticos, no evidencia del recorrido completo de alta por API. Los contenedores, volúmenes temporales, red y archivos privados de configuración se retiran al terminar.

### Imagen web y despliegue de referencia

`pnpm image:build:web` construye `quenda-web:local` desde la revisión actual. La imagen compila `web/` con el lockfile y sirve únicamente `dist` con nginx sin privilegios (usuario 101, puerto 8080); no incluye mapas de código, herramientas de compilación ni credenciales, y las licencias de las dependencias empaquetadas permanecen en `/licenses`. Nginx devuelve la aplicación para cualquier ruta que no sea un archivo, pero responde 404 a un activo con hash ausente para que la recarga por actualización de versión no reciba HTML. Los activos con hash se sirven con `Cache-Control: public, max-age=31536000, immutable` y `index.html` con `no-cache`.

Las respuestas estáticas llevan `Content-Security-Policy` (`default-src 'self'`, sin `unsafe-eval` ni scripts en línea, `connect-src 'self'`, `frame-ancestors 'none'`), `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, `Cross-Origin-Opener-Policy` y `Cross-Origin-Resource-Policy`. `Strict-Transport-Security` se emite cuando un proxy de confianza envía `X-Forwarded-Proto: https`, de modo que la terminación TLS corresponde a la entrada del ayuntamiento o a un proxy delante del contenedor. `/api/`, `/health/` y `/legal/source` se dirigen a `QUENDA_API_UPSTREAM` (por defecto `api:3000`), reconstruyen `X-Forwarded-For` con una sola dirección resuelta y `X-Forwarded-Proto` con el protocolo validado y sustituyen las cabeceras de seguridad de la API por una política `default-src 'none'`. Los activos admiten gzip también para HTTP/1.0. El cuerpo máximo es 1 MB. `/healthz` responde sin consultar la API.

[compose.production.example.yaml](compose.production.example.yaml) y [.env.production.example](.env.production.example) describen una instancia en un único servidor: PostgreSQL 17.11, tarea `bootstrap` (perfil `setup`, una vez), tarea `migrate` previa a la API, API, worker de correo y web. La base y las tareas están en una red interna sin salida; la API y el worker se conectan también a la red de entrada para SMTP. Todos los contenedores de aplicación son de solo lectura, sin capacidades y sin elevación de privilegios. Copiar el archivo de entorno a `.env.production`, restringir su acceso y sustituir cada valor; no guardarlo en Git. Es una referencia para adaptar, no una oferta gestionada: dimensionamiento, almacenamiento de secretos, TLS, copias y monitorización los decide la entidad que opera la instancia ([PD-OPERACION](docs/06_decisiones_y_validacion.md#decisiones-pendientes)).

```sh
pnpm image:build quenda-backend:local && pnpm image:build:web
docker compose --env-file .env.production -f compose.production.example.yaml up -d db
docker compose --env-file .env.production -f compose.production.example.yaml --profile setup run --rm bootstrap
docker compose --env-file .env.production -f compose.production.example.yaml up -d
```

En una instancia nueva todavía no hay operador de plataforma, y sin él no se puede dar de alta ningún municipio. Crear una cuenta desde la aplicación, verificar su correo, activar la verificación en dos pasos y copiar su identificador desde los datos de la cuenta. Después, una sola vez, con las credenciales de mantenimiento de la tarea `migrate`:

```sh
docker compose --env-file .env.production -f compose.production.example.yaml run --rm migrate scripts/initialize-operator.ts IDENTIFICADOR_DE_CUENTA
```

Se aplican las reglas de [Primer operador](#primer-operador).

`TRUSTED_PROXY_CIDRS=172.28.10.10/32` limita la confianza de la API a la dirección fija del contenedor nginx. En nginx, `QUENDA_TRUSTED_PROXY_CIDR` identifica un único CIDR del proxy TLS inmediato; su valor inicial es loopback y debe ajustarse a la dirección real que llega al contenedor, que Docker puede traducir al publicar el puerto. El proxy de entrada debe sanear las cabeceras de cliente. Nginx ignora cabeceras reenviadas de otros pares y resuelve recursivamente la dirección del cliente solo en la cadena confiable; no configurar redes completas de clientes como proxies. `AUTH_ORIGIN` es el origen HTTPS público. Una actualización construye o descarga las imágenes nuevas y repite `up -d`: `migrate` se ejecuta antes de reemplazar la API y, si falla, la API no arranca; aplicar [la recuperación de una actualización fallida](#recuperación-de-una-actualización-fallida). Las copias y restauraciones siguen los procedimientos de [copia lógica](#copia-lógica-de-postgresql) y [restauración cerrada](#restauración-cerrada-a-la-aplicación), ejecutados con el cliente PostgreSQL 17 desde fuera de estos contenedores. `pnpm test:oci` verifica ambas imágenes locales (`QUENDA_IMAGE`, `QUENDA_WEB_IMAGE`) y la integración continua valida además la sintaxis de la composición.

### Métricas HTTP

La API emite `HTTP_METRICS` cada 30 segundos con acumulados locales de solicitudes terminadas: `read` agrupa GET/HEAD y `write` los demás métodos. Incluye respuestas correctas, redirecciones, errores de cliente y servidor, duración total y máxima, y un histograma de latencia. Cada solicitud incrementa un único intervalo; `bucketUpperBoundsMs` indica sus límites superiores inclusivos y `+Inf` recoge el resto. No son percentiles exactos ni métricas exclusivas de comandos válidos: incluyen autenticación, salud y solicitudes rechazadas.

`HTTP_SERVER_ERRORS` registra únicamente los nuevos errores 5xx desde el informe anterior. No convierte respuestas 4xx en fallos del servidor ni repite alertas sin errores nuevos. Los contadores se reinician con el proceso; no incluyen ruta, parámetros, cuerpo, cuentas ni municipio y tienen tamaño fijo. El temporizador se elimina al cerrar la API. La agregación entre réplicas, los umbrales operativos y el destino de las alertas pertenecen a la configuración del despliegue.

### Copia lógica de PostgreSQL

`PG_BIN=/ruta/postgresql17/bin BACKUP_DATABASE_URL=… pnpm db:backup /directorio-privado/copia.dump` crea un archivo custom de `pg_dump` y devuelve ruta, SHA-256 y duración observada. Proporcionar la URL mediante un mecanismo de secretos, no dejarla en historial de shell. Requiere un rol administrativo de copia con lectura íntegra; no utilizar credenciales web. No activa filtrado RLS ni acepta una copia parcial como completa. Las opciones de conexión admitidas son TLS y `connect_timeout`.

El archivo se prepara con modo `0600`, se sincroniza y solo se publica al terminar sin errores ni diagnósticos de `pg_dump`; un destino existente nunca se reemplaza. El SHA-256 permite comprobar integridad, no cifra ni autentica la copia. El almacenamiento debe tener cifrado, acceso y conservación aprobados para sus datos. Las copias contienen información personal y material de autenticación.

La copia incluye datos, esquemas, permisos e historial de migraciones de una base, no roles globales, contraseñas de roles ni secretos externos. Estos se provisionan por separado en el destino. `AUTH_SECRET` es la excepción: cifra los secretos TOTP y los códigos de respaldo guardados en la base, así que el destino debe recibir el mismo valor por un canal seguro. Con otro secreto la copia se restaura, pero ninguna cuenta puede verificar su segundo factor. El formato se restaura con `pg_restore`; una copia debe proceder de una fuente confiable porque puede contener código SQL ejecutable. [Documentación de pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html). El runtime OCI no instala herramientas PostgreSQL: ejecutar este comando en el entorno operativo de copias con el cliente 17 disponible.

`PG_BIN=/ruta/postgresql17/bin node --test test/integration/recovery.test.ts` ensaya la restauración en otro clúster temporal, con contraseñas de roles distintas. Compara cuentas, reservas, ocupaciones, convenios, consumos, eventos, avisos e idempotencia con el corte; comprueba aislamiento, rechazo de credenciales antiguas, replay sin duplicación y cancelación posterior. Informa de tiempos locales y de una reserva creada después de la copia que no se recupera. Son medidas de una fixture pequeña, no un RTO/RPO comprometido. La prueba no abre tráfico ni envía correo desde el destino restaurado.

### Restauración cerrada a la aplicación

`PG_BIN=/ruta/postgresql17/bin RESTORE_ADMIN_DATABASE_URL=… pnpm db:restore /directorio-privado/copia.dump SHA256 nombre_nuevo` verifica una copia privada del archivo y restaura con `pg_restore --single-transaction --exit-on-error`. El checksum debe obtenerse por un canal confiable; no sustituye la comprobación de procedencia del archivo.

El destino debe ser un clúster aislado con los cuatro roles de Quenda provisionados con credenciales propias, sin privilegios elevados ni membresías. El comando requiere un administrador PostgreSQL con capacidad de superusuario: la base se crea con límite de conexiones cero y se revoca el acceso público antes de restaurar. No admite reemplazar una base existente ni ejecuta `DROP` o `--clean`. Si falla después de crearla, la base permanece cerrada para su inspección; no se elimina automáticamente.

El resultado `RESTORED_CLOSED` confirma la carga del archivo, no autoriza tráfico. La API y los workers deben permanecer detenidos hasta verificar migraciones, propietarios, permisos y RLS, conciliar reservas/ocupaciones/consumos y revisar avisos pendientes frente a entregas anteriores al incidente. También se concilian las actuaciones de privacidad posteriores al corte y se revisa la barrera de recuperación. Solo después de aprobar estas comprobaciones se habilitan las conexiones y los permisos mínimos de cada rol. El comando no realiza esa apertura ni reinicia envíos. La recuperación de un despliegue fallido y el procedimiento operativo completo requieren validación adicional.

### Recuperación de una actualización fallida

Detener el avance de la actualización si falla una migración o la comprobación de disponibilidad; no abrir tráfico ni arrancar workers con una versión sin validar. Cada archivo de migración se confirma en su propia transacción: un fallo revierte ese archivo, pero conserva los anteriores que hayan terminado. Revisar el historial antes de elegir la recuperación; nunca borrar sus entradas para forzar una repetición.

Si falla una migración todavía no aplicada, corregirla y continuar con el conjunto completo, conservando intactos los archivos ya aplicados. Un conjunto antiguo que omite migraciones confirmadas será rechazado. Si el esquema ya cambió, volver al ejecutable anterior solo es válido cuando su compatibilidad con ese esquema esté probada; no existe un rollback genérico de base de datos. Ante cambios incompatibles, mantener el servicio cerrado y usar una corrección hacia delante o una restauración aislada, conciliando las escrituras posteriores al corte antes de reabrir.

`PG_BIN=/ruta/postgresql17/bin node --test test/integration/deployment-recovery.test.ts` ensaya una migración aditiva confirmada seguida de otra fallida: verifica rollback de DDL y datos del archivo fallido, liberación del bloqueo de migraciones, conservación de reservas y efectos asociados, rechazo del conjunto antiguo y continuación con el archivo corregido. Comprueba lectura y cancelación de la reserva después del fallo y de la recuperación, respectivamente. Informa del tiempo local y de la pérdida observada; no prueba compatibilidad de versiones futuras ni sustituye las comprobaciones de cada actualización.

`RESTORE_ADMIN_DATABASE_URL=… pnpm db:reconcile` inspecciona la base indicada con una transacción de solo lectura e instantánea consistente. Usar la URL de la base restaurada y credenciales administrativas fuera del runtime. Exige visibilidad completa para no confundir el filtrado RLS con ausencia de incidencias. Compara el historial de migraciones con el código, las reservas y bloqueos con sus ocupaciones activas, los consumos existentes con su titular/intervalo/semana, su correspondencia con los eventos, las atribuciones exigidas por adscripciones vigentes o futuras y las revisiones de reservas con sus eventos. Devuelve solo recuentos, sin identidades ni contenido de reservas. Sale con código 2 ante incoherencias y 1 si no puede completar la comprobación.

`CHECKED_REQUIRES_REVIEW` no autoriza reapertura: el informe no reconstruye escrituras posteriores a la copia, no reconstruye atribuciones históricas si faltan tanto el consumo como su evidencia y no valida por sí solo permisos, RLS o la procedencia del respaldo. Mantener API y workers detenidos. Contrastar reservas confirmadas después del corte con evidencia externa al respaldo y resolver diferencias con los municipios afectados. Revisar los avisos pendientes, arrendados y agotados frente al registro del transporte: una entrega anterior al incidente puede no constar en la copia. No reenviar ni marcar entregados en bloque. El comando no modifica estados, recupera arrendamientos, envía correo ni habilita conexiones; la revisión operativa sigue siendo obligatoria incluso cuando todos los recuentos de incoherencia son cero.

### Inventario de licencias de dependencias

`pnpm --silent licenses:inventory > /directorio-privado/licencias.json` recorre el grafo de dependencias de pnpm, distingue runtime y desarrollo y registra licencia declarada, archivos de evidencia y sus SHA-256. Incluye textos de licencia presentes en README; una mención o enlace no cuenta como texto. No depende del índice de `pnpm licenses`. Las entradas no instaladas, incluidas variantes de plataforma, se enumeran por separado. No incluye las licencias del sistema operativo ni de la imagen base.

El código de salida 2 indica evidencia pendiente; 1 indica que no pudo terminar el inventario. `EVIDENCE_COLLECTED` solo confirma recopilación, no compatibilidad jurídica ni cumplimiento de atribuciones. Revisar los textos y avisos de cada versión antes de distribuirla; conservarlos también en el artefacto. La compatibilidad y las obligaciones de acceso al código fuente se contrastan con la [guía de GNU sobre licencias](https://www.gnu.org/licenses/license-list.html) y la [explicación de la AGPL](https://www.gnu.org/licenses/why-affero-gpl.html). La oferta debe corresponder a la versión ejecutada, incluidas sus modificaciones; el inventario no implementa ni verifica esa entrega.

### Archivo de código fuente de una revisión

`pnpm --silent source:archive /directorio-privado/quenda-source.tar.gz` empaqueta `HEAD` en un destino nuevo y devuelve revisión, SHA-256 y número de archivos. Requiere un árbol limpio: incluye código, migraciones, scripts, configuración de construcción, lockfile, licencia y demás archivos versionados; no incluye `.git`, archivos ignorados ni dependencias instaladas. Rechaza enlaces, submódulos, atributos de exportación y nombres restringidos de secretos o datos. Esta comprobación de nombres no sustituye la revisión del contenido antes de distribuirlo.

Conservar el archivo junto al artefacto construido desde esa misma revisión. No asociarlo a una imagen creada desde cambios pendientes ni a una versión distinta. El comando no publica el archivo, no crea una URL y no demuestra por sí solo que esté completo el código fuente correspondiente de terceros. Antes de un despliegue sujeto a AGPL, completar las atribuciones y proporcionar acceso gratuito al código fuente correspondiente a la versión ejecutada, incluidos los cambios y elementos de construcción necesarios. Verificar la descarga desde la perspectiva del usuario; una referencia a la rama principal no identifica por sí sola esa versión.

La API ofrece `GET /legal/source` sin autenticación. Configurar conjuntamente `SOURCE_ARCHIVE_PATH`, `SOURCE_ARCHIVE_SHA256` y `SOURCE_REVISION` con el archivo y recibo anteriores; el archivo debe estar disponible en el entorno de ejecución. El arranque verifica tamaño máximo de 16 MiB, formato gzip y checksum, y conserva los bytes verificados para que un reemplazo posterior del archivo no cambie la descarga. Un error de configuración impide el arranque sin exponer rutas ni contenido en el mensaje.

La respuesta incluye revisión, SHA-256, ETag y nombre del archivo. Las respuestas de la API anuncian la descarga mediante una cabecera `Link`; no depende de la base de datos ni crea sesiones. Sin configuración responde 503 y no anuncia una oferta inexistente. Antes de distribuir o desplegar, verificar que el archivo corresponde al artefacto y que el usuario puede descargarlo; estas variables no demuestran por sí solas esa correspondencia ni resuelven las atribuciones pendientes. La aplicación web enlaza la descarga desde el pie de página («Código fuente»).

### Auditoría de consultas municipales de reservas

Las páginas municipales registran cada reserva devuelta; la consulta de detalle registra el acceso cuando quien consulta no es el titular. El registro contiene municipio, reserva, actor, operación, correlación de la solicitud y fecha, sin copiar datos de la reserva ni credenciales. La consulta y la auditoría comparten transacción: si falla el registro, no se devuelve la información. El registro vuelve a comprobar y bloquear el permiso vigente por unidad antes de confirmar.

Los roles de API, autenticación y worker no pueden leer, alterar ni borrar directamente esta auditoría. Las consultas personales del titular no se convierten en accesos de soporte. Para una intervención municipal se utilizan permisos delegados de alcance mínimo y con caducidad; no existe un permiso global de soporte ni una excepción al aislamiento. La autorización y revocación conservan sus eventos de delegación. La conservación y consulta operativa de estas evidencias siguen sujetas a la política aprobada del despliegue.

### Ensayo de rendimiento

`PG_BIN=/ruta/postgresql17/bin pnpm test:performance` crea una base temporal con 3 municipios, 30 unidades y 3.000 reservas históricas sintéticas, autentica 10 sesiones y ejercita HTTP en loopback. Tras 60 segundos de calentamiento separado, programa 3.000 solicitudes en 10 minutos: 70 % consulta de reservas propias, 10 % disponibilidad y 20 % altas de reservas. No omite solicitudes lentas ni cuenta ensayos abreviados como aceptación. `--smoke` reduce únicamente calentamiento y medición para comprobar el montaje; conserva el conjunto de datos completo y nunca aprueba el escenario.

`pnpm test:performance:history` prepara por separado 50.000 reservas históricas y 50.000 eventos, comprueba la paginación inicial, siguiente y por día y selecciona 100 candidatos de conservación. Registra cinco muestras calientes por operación y revisión/estado del árbol en un JSON temporal; no sustituye la carga sostenida.

El informe JSON privado en el directorio temporal incluye revisión, cambios pendientes, entorno, muestras, percentiles, errores, abortos, conexiones y retraso de avisos. El correo usa transporte sintético sin latencia externa. Para aprobar exige una revisión limpia, todas las solicitudes válidas, los límites p95 definidos y ausencia de avisos sin aceptar al terminar la espera acotada. Los resultados describen este equipo y esta mezcla de operaciones, no un SLA ni capacidad del proveedor de correo o de otros endpoints.

## Privacidad y conservación

Los permisos `PRIVACY_READ` y `PRIVACY_EXECUTE` son explícitos, requieren MFA reciente y no se heredan del rol de administrador u operador. Para un municipio se conceden mediante las invitaciones de gestores, con `unitId: null`. La concesión global utiliza `/api/platform/privacy-invitations` y requiere aceptación del destinatario; solo cubre identidad y evidencias globales, no actividad municipal. Una baja o suspensión retira las concesiones y no las recupera automáticamente.

### Descarga personal

- `GET /api/me/personal-data`: JSON `quenda.personal-data` v1 con la proyección accesible del titular entre municipios.
- `POST /api/municipalities/{tenantId}/accounts/{accountId}/personal-data`: proyección municipal con `PRIVACY_READ` del municipio.
- `POST /api/platform/accounts/{accountId}/personal-data`: proyección global con permiso global explícito, sin historiales municipales.

Las dos vías administrativas reciben `reason` y `authorizationReference`. Admiten cuentas desactivadas sin reactivarlas. Todas las respuestas indican `completeness.status: PARTIAL`, las exclusiones y la revisión administrativa necesaria. No se entregan secretos ni texto libre sin revisión. Superar 10.000 registros o 10 MiB devuelve `409 PERSONAL_DATA_TOO_LARGE`, sin truncar. La descarga no acredita por sí sola una respuesta completa al derecho de acceso ni la aplicabilidad del derecho de portabilidad.

### Cambio de correo

Una dirección ocupada sigue el mismo recorrido inicial de autorización y verificación; la unicidad solo se comunica tras comprobar el control de ambos correos.

1. `POST /api/me/email-change/request`, con `newEmail` y contraseña actual, envía la autorización al correo actual.
2. `POST /api/me/email-change/approve`, con el token recibido, consume esa autorización y envía la verificación al nuevo correo.
3. `POST /api/me/email-change/confirm`, con el segundo token, cambia el correo y revoca todas las sesiones. Hay que iniciar sesión con la nueva dirección.

El autoservicio mantiene la sesión original y exige MFA reciente cuando esté habilitado. Los tokens caducan a los diez minutos y no sobreviven a cambios incompatibles de credenciales o estado. Los enlaces transportan el token en el fragmento; ningún GET confirma el cambio. La ruta nativa `/api/auth/change-email` no se expone.

Si el usuario perdió el buzón anterior, `pnpm email:recover <cuenta> <nuevo-correo> <responsable-operativo> <referencia-verificación> <motivo>` inicia el procedimiento asistido con credenciales de mantenimiento. Además de `.env.migration.local`, el entorno debe definir `AUTH_ORIGIN` y la configuración de correo (`MAIL_TRANSPORT` y sus variables). No cambia la identidad inmediatamente: el titular confirma el nuevo buzón, contraseña y MFA desde una sesión propia. No reactiva cuentas ni recupera permisos.

### Revisión de conservación compartida

`POST /api/municipalities/{tenantId}/shared-retention/context` recibe `ownerTenantId`, `category` (`RESERVATIONS` o `ACCREDITATIONS`), `targetKey`, `action` y `blockDays` solo para `BLOCK`. Requiere `PRIVACY_READ` municipal y MFA reciente; devuelve la huella y los responsables históricos con su estado de aprobación, sin contenido personal. `POST /shared-retention/review` en la misma base añade `digest`, `approved`, `authorizationReference` y `reason`; exige además `PRIVACY_EXECUTE`. Solo registra la decisión del municipio autenticado.

Las aprobaciones vinculan registro, evidencias, política vigente, actuación y plazo; cualquier cambio requiere revisarlas. La ejecución individual o por política comprueba unanimidad, dependencias y excepciones de todos los responsables. Los archivos bloqueados conservan ese ámbito para respetar excepciones posteriores. El checkpoint incluye la prueba de revisión para reproducir la actuación durante una restauración cerrada. Véase el [modelo de conservación](docs/02_modelo_dominio.md#ejecución-y-excepciones).

### Políticas y actuaciones

Bases de API: `/api/municipalities/{tenantId}` y `/api/platform`. El ámbito global solo admite `IDENTITY`, `AUTHENTICATION` y `AUTHORITY`.

| Operación | Ruta relativa | Permiso |
|---|---|---|
| Aprobar una política | `POST /retention-policies` | `PRIVACY_EXECUTE` |
| Consultar políticas | `GET /retention-policies` | `PRIVACY_READ` |
| Retirar una política | `POST /retention-policies/{policyId}/revoke` | `PRIVACY_EXECUTE` |
| Registrar una excepción de conservación | `POST /retention-holds` | `PRIVACY_EXECUTE` |
| Levantar una excepción | `POST /retention-holds/{holdId}/release` | `PRIVACY_EXECUTE` |
| Consultar excepciones y conflictos | `GET /retention-status` | `PRIVACY_READ` |
| Ejecutar una actuación individual autorizada | `POST /privacy-actions` | `PRIVACY_EXECUTE` |

La política recibe `category`, `retentionDays`, `action`, `purpose`, `controllerReference`, `approvalReference` y `reason`. `BLOCK` exige además `blockDays`; `ERASE` no lo admite. Los periodos son días completos de 24 horas desde el anclaje definido para la familia, sin valores legales predeterminados. Una nueva aprobación sustituye la política activa de esa familia y ámbito. El límite técnico de 365.000 días no es una recomendación de conservación. No se ejecutan scripts, SQL ni selectores libres introducidos por un administrador.

| Familia | Selección y anclaje |
|---|---|
| `COMMUNICATIONS` | Aviso, cola e intentos de un evento; última actividad del conjunto. Un envío con concesión vigente impide la actuación. |
| `RESERVATIONS` | Reserva, ocupaciones e historial; fin de la reserva o último evento de reserva/consumo, el posterior. Se preservan comunicaciones aún retenidas e idempotencia vigente; los consumos compartidos exigen aprobación conjunta. |
| `MUNICIPAL_PROFILE` | Perfil sin dependencias protegidas; última actividad municipal conservada. Suprimirlo no cierra la cuenta global. |
| `AUTHORITY` | Permisos e invitaciones retirados o vencidos, y evidencias asociadas; último hecho del conjunto. Los accesos de privacidad y rechazos globales se tratan por evento independiente. |
| `ACCREDITATIONS` | Acreditación vencida o revocada; revocación, si existe, o fin de vigencia en otro caso. Las evidencias compartidas requieren revisión de los responsables. |
| `AUTHENTICATION` | Eventos de seguridad cerrados y artefactos técnicos vencidos; hecho registrado o vencimiento. No elimina credenciales activas por antigüedad. |
| `IDENTITY` | Cuenta dada de baja; instante de baja, sin autoridad, conflictos de seguridad ni evidencia municipal dependiente. Retira acceso y datos directos; los identificadores residuales no se consideran anónimos. |

El worker existente revisa la conservación cada minuto en lotes acotados. La selección de registros ordinarios requiere una política aprobada. Los archivos bloqueados siguen su autorización y fecha de destrucción, aunque procedan de una actuación individual o la política original ya no esté activa. Cada actuación respeta las excepciones, vuelve a comprobar el estado y confirma cambios y auditoría en una transacción. Los conflictos se registran sin eliminar el conjunto afectado; se reevalúan con espera para que no impidan avanzar a otros registros. Cada municipio puede tener periodos distintos en la misma instancia.

`BLOCK` retira el registro de las consultas ordinarias y guarda el contenido necesario en `retention_archive`, inaccesible a los roles de ejecución. No copia secretos de autenticación. La destrucción posterior utiliza la fecha aprobada y respeta excepciones vigentes. `domain.read_blocked_privacy_record` solo está disponible en mantenimiento y exige referencia de autorización, finalidad legal y correlación; registra el acceso. El responsable debe verificar que la consulta excepcional esté legalmente permitida.

Una excepción identifica `category` y exactamente uno de `targetKey` o `subjectId`, junto con `authorizationReference` y `reason`. Impide la eliminación correspondiente; no bloquea por sí sola el uso ordinario de los datos. La actuación individual recibe categoría, registro, acción, referencia de autorización y motivo, más `blockDays` cuando corresponda. Su respuesta diferencia `APPLIED`, `CONFLICT` y `ABSENT`: HTTP 200 confirma una evaluación auditada, no necesariamente una eliminación. No sustituye la tramitación administrativa de una solicitud de derechos.

### Recuperación sin rehabilitar datos suprimidos

```sh
pnpm privacy:checkpoint /directorio-privado/privacidad.json
RESTORE_ADMIN_DATABASE_URL=… pnpm privacy:restore-reconcile /directorio-privado/privacidad.json SHA256 REFERENCIA_AUTORIZACION
```

El checkpoint utiliza credenciales de mantenimiento, un destino nuevo con modo `0600` y un checksum. Contiene referencias de actuaciones y excepciones, no contenidos bloqueados ni secretos. Debe conservarse fuera de las copias antiguas y actualizarse mediante el procedimiento operativo de respaldo. Su procedencia y actualidad se comprueban por separado: un hash no demuestra que el archivo sea el último. La ausencia de evidencia actual impide autorizar la reapertura.

`db:restore` activa `restore_review_required`, además de cerrar conexiones. API y workers rechazan el arranque mientras esté activo, aunque se hayan vuelto a conceder permisos de conexión. La conciliación de privacidad reproduce eliminaciones y bloqueos del checkpoint, conserva su evidencia para futuras copias y deja las políticas restauradas desactivadas para revisión. No abre el servicio ni presume resueltos conflictos de conservación.

El responsable operativo debe verificar el checkpoint más reciente, resolver diferencias con los responsables del tratamiento, revisar políticas y excepciones y completar `db:reconcile` antes de retirar la barrera de recuperación mediante mantenimiento autorizado. Los comandos no realizan esa autorización. El diario contiene referencias personales; su retirada se coordina con la caducidad de las copias recuperables y la política de conservación, no con una eliminación automática por antigüedad arbitraria.
