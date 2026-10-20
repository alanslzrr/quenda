# Quenda backend

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

`db:local:config` genera contraseñas aleatorias en archivos locales excluidos de Git y no sobrescribe configuraciones existentes. `db:bootstrap` se ejecuta una sola vez sobre una base dedicada nueva: crea roles y esquemas; falla si ya existen. No utilizarlo sobre bases compartidas con otros productos.

La API escucha en `127.0.0.1:3000`. `GET /health/live` comprueba el proceso; `GET /health/ready`, las conexiones y los privilegios de ejecución. No devuelven credenciales ni datos del dominio.

El proceso web recibe exclusivamente la configuración de `.env.local`. Las credenciales de migración y administración permanecen en archivos separados. El runtime de autenticación no posee sus tablas; sus migraciones se ejecutan con el rol de migración.

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

Al invitar a un administrador, `roleExpiresAt` permite fijar la caducidad del rol; es independiente de `expiresAt`, que limita la aceptación. Omitirlo o enviar `null` concede el rol sin vencimiento temporal, sujeto a revocación. Un permiso vencido no autoriza operaciones ni nuevas aceptaciones de sus delegaciones; renovarlo requiere otra invitación y no reactiva las anteriores.

`GET /api/municipalities/{tenantId}/profiles` permite al administrador con MFA reciente consultar los perfiles vinculados a ese municipio. Devuelve `accountId` y `createdAt`, hasta 20 elementos y `nextCursor`; la página siguiente utiliza `?after=...`. No incluye cuentas sin vínculo municipal ni datos de identidad global. Los gestores y operadores sin rol administrativo en ese municipio no pueden utilizar esta consulta.

`GET /api/municipalities/{tenantId}/administrators` muestra la última asignación administrativa de cada cuenta, su invitación de origen, vigencia, revocación y estado `active` al consultar. `GET /api/municipalities/{tenantId}/administrator-invitations` muestra el historial de invitaciones, incluida su aceptación. Ambas consultas requieren administración municipal y MFA reciente; devuelven hasta 20 elementos y `nextCursor`. Una invitación aceptada no acredita autoridad actual: una revocación o renovación puede haber cambiado la asignación.

## Nombre de la cuenta

`POST /api/auth/update-user` recibe exclusivamente `{ "name": "..." }` y modifica el nombre del titular de la sesión. El nombre admite hasta 200 caracteres, se guarda sin espacios exteriores y no puede quedar vacío ni contener caracteres de control. La operación no modifica el correo, la verificación, el MFA ni los permisos. El nombre actualizado se consulta mediante `GET /api/auth/get-session`. Cambiar el nombre no acredita una identidad legal.

## Gestores municipales

`POST /api/municipalities/{tenantId}/manager-invitations` recibe `accountId`, `expiresAt`, `roleExpiresAt` opcional y `permissions: [{ operation, unitId }]`. El administrador invita; el destinatario acepta con MFA mediante `/{invitationId}/accept`. `/{invitationId}/revoke` revoca la invitación o concesión con `{ "reason": "..." }`.

`GET /api/me/manager-invitations` devuelve las invitaciones y concesiones de la cuenta autenticada, con sus permisos y estado. Devuelve hasta 20 elementos y `nextCursor`; la página siguiente utiliza `?after=...`. No admite consultas de otra cuenta.

Para sustituir una concesión, la nueva invitación incluye `replacesInvitationId` y `reason`. La concesión anterior permanece activa hasta la aceptación: esta activa los nuevos permisos y revoca los anteriores en una sola transacción auditada. Las demás concesiones independientes no cambian. Si es necesario retirar acceso inmediatamente, se utiliza la revocación; no se espera a la aceptación de una sustitución.

`GET /api/municipalities/{tenantId}/manager-invitations` permite al administrador con MFA reciente consultar las invitaciones y concesiones del municipio. Incluye destinatario, emisor, permisos, referencia de sustitución y fechas de vencimiento, aceptación y revocación. Devuelve hasta 20 elementos y `nextCursor`; la página siguiente utiliza `?after=...`. Las fechas describen el historial y no sustituyen la comprobación de autoridad vigente de cada operación.

Cada permiso se limita a una operación y unidad real del municipio; `unitId: null` abarca el municipio. `CATALOG_CREATE` exige ámbito municipal. Las operaciones admitidas son `CATALOG_CREATE`, `CATALOG_MANAGE`, `RESERVATION_READ`, `RESERVATION_MANAGE`, `UNIT_BLOCK`, `REPORT_READ` y `DATA_EXPORT`. Ninguna concede administración de cuentas. Las altas del catálogo ya aplican este control; el resto se integrará al implementar sus respectivos módulos.

## Catálogo en borrador

`POST /api/municipalities/{tenantId}/facilities` crea una instalación; `POST /api/municipalities/{tenantId}/facilities/{facilityId}/units` crea una unidad. Ambos reciben `{ "name": "..." }`, requieren el permiso municipal `CATALOG_CREATE` y MFA reciente y registran auditoría. Las altas persisten como borradores: no publican recursos ni permiten reservarlos.

`GET /api/municipalities/{tenantId}/facilities/{id}` y `GET /api/municipalities/{tenantId}/units/{id}` consultan un recurso para mantenimiento. `PATCH` sobre esas mismas rutas recibe `{ "name": "..." }` y registra el nombre anterior y el nuevo en la misma transacción. Requieren `CATALOG_MANAGE` y MFA reciente: ámbito municipal para instalaciones, municipal o de la unidad concreta para unidades. No permiten cambiar identificadores ni trasladar unidades entre instalaciones o municipios. Si falla la auditoría, el cambio se revierte.

`GET /api/municipalities/{tenantId}/facilities` y `GET /api/municipalities/{tenantId}/units` listan los recursos visibles para la cuenta con MFA reciente. Devuelven hasta 20 elementos y `nextCursor`; la página siguiente utiliza `?after=...`. RLS filtra antes de paginar: un gestor limitado a determinadas unidades no obtiene las restantes ni acceso municipal a instalaciones. Sin recursos autorizados, la respuesta es una lista vacía. Estos listados son administrativos, no publicaciones del catálogo público.

`POST /api/municipalities/{tenantId}/facilities/{id}/withdraw` y la ruta equivalente `/units/{id}/withdraw` reciben `{ "reason": "..." }`. Registran la retirada y su motivo sin eliminar el recurso. Repetir la retirada devuelve el mismo instante sin duplicar el evento. Las consultas administrativas incluyen `withdrawnAt`; `null` indica que no se ha retirado, no que esté publicado. Una instalación retirada conserva sus unidades y no admite nuevas altas. Las reservas deberán comprobar la retirada de la unidad y de su instalación.

## Calendarios de unidades

`PUT /api/municipalities/{tenantId}/units/{unitId}/calendar` recibe `expectedVersion`, `reason` y `calendar`. La primera configuración usa `expectedVersion: 0`; las siguientes deben indicar la versión actual o reciben `409 CONFLICT`. Cada versión conserva configuración, autor, motivo e instante; el rol web no puede modificarla ni eliminarla. Requiere `CATALOG_MANAGE` sobre la unidad y MFA reciente.

`calendar` contiene `minimumMinutes`, `maximumMinutes`, `stepMinutes`, `advanceDays`, `weekly` y `exceptions`. Las duraciones son múltiplos positivos del paso. `advanceDays: null` hereda el límite municipal; un valor explícito solo puede reducirlo. Los horarios usan días ISO 1–7 y minutos locales desde medianoche: `{ day, startMinute, endMinute }`. El final puede ser 1440; un intervalo que cruza medianoche se divide entre dos días. Las excepciones `{ date, intervals }` sustituyen el horario semanal de esa fecha; `intervals: []` representa cierre. Se rechazan fechas inválidas, duplicados y solapes.

`GET` sobre la misma ruta devuelve la versión actual; `?version=N` recupera una versión histórica. Guardar un calendario no publica la unidad. El guardado rechaza horarios o excepciones que dejen sin cobertura una reserva confirmada pendiente de finalizar, incluidas las que están en curso. La comprobación y el cambio de versión comparten una transacción SERIALIZABLE. Las reservas conservan sus condiciones aceptadas de duración y antelación; las nuevas reglas no reescriben su historial.

## Publicación del catálogo

`POST /api/municipalities/{tenantId}/facilities/{id}/publish` recibe `{ "reason": "..." }`. Para una unidad, `/units/{id}/publish` exige además `calendarVersion` e `independenceConfirmed: true`. La instalación debe estar publicada y no retirada; el calendario indicado debe ser el actual y superar la validación de reglas. La confirmación de independencia física queda auditada con el actor y la versión: no es una detección automática de espacios solapados.

Publicar elimina la retirada del recurso indicado, sin borrar historial. Republicar una instalación vuelve a habilitar sus unidades previamente publicadas que no estén retiradas individualmente. Los cambios no alteran las reservas existentes. `publishedAt` y `withdrawnAt` se incluyen en las consultas administrativas; la disponibilidad pública deberá considerar también el estado de la instalación. La publicación no sustituye el cálculo de disponibilidad, todavía pendiente.

## Tiempo civil y zonas IANA

La conversión usa `@js-temporal/polyfill` 0.5.1: Node 24.21.0 no expone Temporal en el entorno verificado. La dependencia evita mantener reglas de conversión horaria propias. Los modos `earlier` y `later`, comprobados mediante conversión de vuelta a hora local, permiten descartar horas inexistentes y conservar ambas ocurrencias de una hora repetida. Cada instante conserva UTC, fecha/hora local, desplazamiento y zona. La antelación compara fechas locales, no bloques de 24 horas. [Modelo temporal y ambigüedad](https://tc39.es/proposal-temporal/docs/timezone.html), [polyfill](https://github.com/js-temporal/temporal-polyfill).

Las pruebas incluyen Madrid, transiciones de media hora en Lord Howe y una fecha completa omitida en Apia. Los intervalos de apertura se intersectan con cada tramo de desplazamiento constante del día. Así, dos aperturas de una hora repetida permanecen separadas si existe un cierre real entre ellas; una jornada completa puede representar 23 o 25 horas reales. La generación de franjas aplica duración real, paso y antelación: los inicios se alinean con el comienzo de cada apertura civil continua y la duración se mide entre instantes UTC. Cada reserva candidata debe quedar íntegramente cubierta por apertura, incluso al cruzar medianoche. Una excepción del día siguiente puede impedir ese cruce. La API pública descarta las franjas que solapan ocupaciones no liberadas de reservas o bloqueos. La revisión completa de licencias y atribuciones sigue pendiente; el polyfill declara ISC y su dependencia JSBI, Apache-2.0.

## Catálogo y disponibilidad públicos

Sin sesión, bajo `/api/public/municipalities/{tenantId}`:

- `GET /facilities`: instalaciones publicadas, hasta 20 por página; `?after=nextCursor` continúa el listado.
- `GET /facilities/{facilityId}/units`: unidades publicadas de una instalación publicada y no retirada, con la misma paginación.
- `GET /units/{unitId}`: nombre, instalación, zona, límites municipales y calendario vigente, sin autor ni motivo de auditoría.
- `GET /units/{unitId}/availability?date=AAAA-MM-DD&durationMinutes=N`: franjas libres con UTC, hora local, desplazamientos, versión y momento de cálculo.

Estas consultas no crean cuentas ni perfiles. Los recursos no publicados o retirados no aparecen; el detalle responde `404`. La disponibilidad lee calendario y ocupaciones en una misma transacción y descarta cualquier solape con una ocupación no liberada. Solo expone franjas, no titulares, identificadores de reservas ni motivos de bloqueos. Consultar no garantiza ni confirma una reserva. Las cuatro rutas comparten un límite de 60 peticiones por 60 segundos y dirección reconocida por Fastify, incluso entre réplicas. Al superarlo devuelven `429 RATE_LIMITED` y `Retry-After`, antes de validar parámetros o calcular franjas. No confían en cabeceras de proxy enviadas por el cliente. PostgreSQL conserva una huella HMAC con clave compartida, no la IP en claro; cada petición elimina hasta 100 contadores cuya ventana tiene más de diez minutos. Sin tráfico, la limpieza se reanuda en la próxima petición; no constituye una garantía de borrado exactamente a los diez minutos. Las réplicas deben compartir `AUTH_SECRET`; rotarlo también reinicia la identidad de estos contadores.

## Consulta de reservas

- `GET /api/municipalities/{tenantId}/reservations/{reservationId}`: estado actual de una reserva. Admite al titular sin MFA y al personal con permisos vigentes sobre la unidad y MFA. Un identificador de otro municipio o fuera del ámbito autorizado no revela la reserva.
- `GET /api/me/reservations`: historial del usuario autenticado entre municipios de la instancia, incluidas reservas de unidades retiradas. Devuelve nombre municipal y de unidad, sin aceptar un identificador de otro usuario.
- `GET /api/municipalities/{tenantId}/reservations`: requiere MFA y devuelve únicamente reservas cubiertas por `RESERVATION_READ` o `RESERVATION_MANAGE`. `?unitId=UUID` filtra sin ampliar permisos. Ser titular de una reserva no concede acceso al listado de gestión.

Los listados devuelven `{ items, nextCursor }`, con hasta 20 elementos y `Cache-Control: no-store`. `?after=nextCursor` continúa el listado. El orden por identificadores es estable, no cronológico; el cursor propio combina reserva y municipio, y el municipal contiene el identificador de reserva. Los permisos se vuelven a comprobar en cada página.

El detalle no devuelve el resultado histórico de un comando: tras cancelar, muestra `CANCELADA` y la nueva revisión, aunque repetir la clave de creación siga recuperando la confirmación original.

Las consultas muestran `FINALIZADA` cuando el fin de una reserva confirmada es anterior o igual al instante de consulta. No modifican el estado almacenado ni ejecutan tareas programadas; una reserva cancelada sigue mostrando `CANCELADA`.

## Confirmación de reservas

`POST /api/municipalities/{tenantId}/reservations` requiere sesión verificada, `Origin` autorizado y cabecera `Idempotency-Key` (1–200 caracteres alfanuméricos, `.`, `_`, `:`, `-`). El cuerpo contiene `unitId`, `startsAt` y `endsAt` como instantes ISO con zona; el titular siempre es el usuario autenticado.

La respuesta `201` contiene la reserva y sus condiciones aceptadas. Repetir la misma clave y contenido devuelve el resultado original, también con `201`; cambiar el contenido devuelve `409`. Las cabeceras `Idempotency-Replayed` e `Idempotency-Expires-At` indican recuperación y vencimiento. `Idempotency-Retention-Seconds` publica la configuración para comandos nuevos: `IDEMPOTENCY_RETENTION_SECONDS`, 86.400 segundos por defecto. El vencimiento ya guardado no cambia al repetir una petición ni al cambiar esa configuración. Una clave caducada puede ejecutar un comando nuevo; no debe reutilizarse para recuperar resultados fuera de su ventana.

La creación valida las reglas vigentes y confirma reserva, ocupación, evento, avisos y resultado idempotente en una sola transacción. Un conflicto no deja cambios parciales. El correo queda pendiente para su entrega por el worker. La disponibilidad pública descuenta las ocupaciones confirmadas, pero no garantiza que una franja siga libre al reservar.

## Modificación de reservas

`POST /api/municipalities/{tenantId}/reservations/{reservationId}/modify` recibe `expectedRevision`, `unitId`, `startsAt` y `endsAt`, con la misma autenticación e idempotencia que la confirmación. Devuelve `200`. No cambia el titular ni el municipio.

El sistema aplica el plazo aceptado de origen y las reglas vigentes del destino. Sustituye la ocupación, conserva la anterior liberada y registra las condiciones anteriores y nuevas. Un conflicto revierte todos los cambios. Una petición sin cambios de unidad o intervalo conserva versión y condiciones y no genera otro evento ni aviso. El modo `administrative: true` exige motivo, MFA reciente y permiso `RESERVATION_MANAGE` tanto en origen como en destino; nunca permite modificar una reserva ya iniciada.

## Cancelación de reservas

`POST /api/municipalities/{tenantId}/reservations/{reservationId}/cancel` recibe `expectedRevision` y utiliza la misma sesión, protección de origen e idempotencia que la confirmación. Devuelve `200` con el estado cancelado. Una reserva ya cancelada no genera otro evento ni otro aviso, aunque se use una clave nueva.

El titular cancela antes de `inicio − plazo aceptado`; la igualdad con el límite ya queda fuera de plazo. `administrative: true` exige permiso `RESERVATION_MANAGE`, MFA reciente y `reason`; permite omitir el plazo del titular, pero nunca cancelar tras el inicio. Una versión obsoleta produce `409`. Reserva, liberación de ocupación, evento y avisos se confirman juntos. La autorización se comprueba también al recuperar un resultado idempotente.

## Bloqueos de unidades

`POST /api/municipalities/{tenantId}/blocks` recibe `unitId`, `startsAt`, `endsAt` y `reason`. Exige `UNIT_BLOCK` sobre la unidad, MFA reciente, origen autorizado e `Idempotency-Key`; devuelve `201`. Los intervalos deben ser finitos y ordenados, sin aplicar al mantenimiento las reglas de duración o antelación de una reserva. Un solape con una reserva o bloqueo no liberado produce `409` sin cambios parciales. Las reservas afectadas deben resolverse mediante operaciones explícitas.

`POST /api/municipalities/{tenantId}/blocks/{blockId}/release` recibe un nuevo `reason` y devuelve `200`. Libera la ocupación y conserva el bloqueo y su motivo original; registra el motivo de retirada en un evento inmutable. Repetir la retirada no genera otro evento. Ambas operaciones son idempotentes y comprueban permisos antes de recuperar resultados. La disponibilidad pública refleja sus efectos tras el commit.

## Integridad de reservas y bloqueos

PostgreSQL mantiene una ocupación activa por reserva confirmada o bloqueo vigente. Una exclusión temporal compartida impide solapes en la misma unidad y municipio; los intervalos son semiabiertos `[inicio, fin)`, por lo que admiten reservas consecutivas. Las claves compuestas impiden referencias entre municipios.

Las restricciones diferidas comprueban al confirmar la transacción que la unidad y el intervalo de la ocupación coinciden con su origen. Cancelar una reserva o liberar un bloqueo exige liberar su ocupación en la misma transacción. Cambiar una reserva sustituye la ocupación sin borrar la anterior; un conflicto revierte todos los cambios. Los permisos SQL y RLS restringen la lectura y modificación al contexto autorizado.

La confirmación HTTP utiliza estas garantías. Los cambios de calendario incompatibles requieren resolver antes las reservas afectadas mediante operaciones explícitas.

## Primer operador

Crear y verificar una cuenta por la API y completar el alta de TOTP antes de inicializar el operador. Con su identificador de cuenta y las credenciales de mantenimiento:

```sh
pnpm operator:initialize IDENTIFICADOR_DE_CUENTA
```

La operación registra una única inicialización auditable. Rechaza cuentas sin correo verificado o MFA y no puede repetirse aunque el operador se revoque. El proceso web no tiene permisos SQL para asignar ni restaurar operadores. Este permiso operativo no concede acceso general a datos municipales.

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

Las pruebas de integración crean una instancia PostgreSQL temporal con contraseñas aleatorias y la eliminan al terminar; no utilizan la base de desarrollo. Requieren los binarios locales `initdb`, `pg_ctl` y `postgres` de la versión indicada. En macOS con Homebrew, `PG_BIN` puede ser `/opt/homebrew/opt/postgresql@17/bin` si contiene esa versión.

La comprobación de arquitectura impide dependencias circulares y accesos a archivos privados de otro módulo. Cada módulo expone su API por `src/modules/<nombre>/index.ts`; la composición inyecta los puertos que evitan dependencias inversas. Las migraciones aplicadas son inmutables y su hash se verifica antes de aplicar otras.

`pnpm build` genera `dist/`. Para comprobar el artefacto compilado con la configuración local: `node --env-file=.env.local dist/server.js`. En ejecución, `pnpm start` recibe las variables desde el entorno. SIGINT y SIGTERM cierran el servidor y sus pools.

## Licencia

Quenda utiliza **AGPL-3.0-only**, no «or later». El [texto íntegro](LICENSE) se distribuye con el proyecto. Los despliegues sujetos a sus obligaciones deben facilitar el código fuente correspondiente; las versiones modificadas accesibles por red deben ofrecerlo a sus usuarios conforme a la sección 13. [Identificador SPDX y términos](https://spdx.org/licenses/AGPL-3.0-only.html).


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

Ambos comandos requieren `Origin` autorizado e `Idempotency-Key`, devuelven cabeceras de idempotencia y `Cache-Control: no-store`, y revalidan permisos antes del replay. No existe un listado general ni una consulta libre de elegibilidad.

Las reservas de unidades adscritas comprueban, en su misma transacción, la vigencia efectiva del convenio, la acreditación que cubre todo el intervalo cuando se exige y la cuota semanal conjunta por cuenta. Crear atribuye el consumo; reprogramar recalcula semana y destino; cancelar lo libera. Una modificación sin cambios conserva la atribución. El rechazo revierte reserva, ocupación, consumo, auditoría y resultado idempotente; no devuelve consumos ni acreditaciones ajenas. La suspensión permite cancelar, pero impide nuevas reservas y reprogramaciones; cerrar la adscripción no activa el acceso público automáticamente.

`POST /api/municipalities/{tenantId}/agreements/{agreementId}/suspend` recibe `version` y `reason`. Un administrador participante con MFA reciente suspende el convenio completo y cierra sus vigencias efectivas, incluidas las programadas. Conserva reservas, consumos y vinculaciones de unidades; registra actor, municipio, motivo y correlación. Devuelve `200` con `SUSPENDIDO`; repetir no duplica eventos. Exige `Origin` autorizado e `Idempotency-Key`. Un borrador o una versión únicamente aprobada no puede suspenderse mediante este comando.

`POST /api/municipalities/{tenantId}/agreements/{agreementId}/activate` activa una nueva versión aprobada, incluida la sustitución o reactivación. Recibe `version`, `legalReviewReference` y `reportReviewReference` (puede ser nula si no se habilitan informes). Exige la versión aprobada más reciente, aprobación de todos los participantes, unidades adscritas y emisor habilitado si se requieren acreditaciones. Concilia las reservas confirmadas de las unidades y vigencia aprobadas, conservándolas aunque superen la cuota o no cumplan la nueva elegibilidad. Devuelve `200` con `ACTIVADO`. La operación completa es idempotente y atómica; exige administrador participante, MFA reciente y `Origin` autorizado. Otra activación de la misma versión con una clave nueva devuelve `409`. Sustituir o reactivar exige una nueva versión y todas sus aprobaciones; cierra las vigencias anteriores sin solapes, conserva sus evidencias y no reinicia los consumos de cuota, tampoco al retirar unidades.

### Reapertura municipal de unidades

- `GET /api/municipalities/{tenantId}/units/{unitId}/agreement-restriction`: devuelve la vinculación persistente o `null`. `hasRemainingAssignment` indica si existen adscripciones actuales o programadas; no representa disponibilidad para reservar.
- `POST /api/municipalities/{tenantId}/units/{unitId}/agreement-restriction/release`: recibe `expectedAgreementId`, `expectedVersion` y `reason`. Retira la restricción únicamente si coincide la vinculación esperada y no quedan adscripciones actuales ni programadas. Conserva publicación, calendario, reservas y consumos; registra actor, motivo y correlación. Devuelve `removed: false` si ya no existe restricción.

Ambos endpoints exigen administrador municipal y MFA reciente. El comando exige `Origin` autorizado e `Idempotency-Key`; revalida permisos antes del replay. Retirar la restricción no publica la unidad ni libera ocupaciones.

### Avisos internos

`GET /api/me/notices` devuelve los avisos del usuario autenticado entre municipios, con `Cache-Control: no-store`. Pagina de 20 en 20 por identificador de evento y municipio; `after` acepta el `nextCursor` anterior. Cada aviso contiene tipo, revisión, fecha del evento e intervalo histórico, junto con `reservationPath` para consultar el estado actual. No expone actores, motivos administrativos ni correlaciones, y no representa el estado de entrega del correo.

### Procesamiento de correo

`processReservationEmail` reclama un evento con el rol `quenda_worker`, confirma la concesión y envía mediante `MailTransport` fuera de la transacción. Registra aceptación, fallo o vencimiento del intento; los tokens vencidos no pueden confirmar resultados. Los eventos se procesan por reserva y revisión. Agotar los intentos conserva el evento y permite continuar con revisiones posteriores.

El rol worker ejecuta funciones acotadas de entrega de correo, estado de la cola y preparación de informes mensuales; no puede consultar directamente reservas, cuentas o intentos. El bootstrap de bases nuevas lo crea con credenciales independientes; `db:local:config` las guarda en `.env.worker.local`, separado del entorno web. Para una base creada antes de incorporar el worker, configurar `BOOTSTRAP_DATABASE_URL` y una contraseña nueva `WORKER_DATABASE_PASSWORD` de al menos 24 caracteres en `.env.bootstrap.local`; ejecutar `pnpm db:provision:worker` antes de aplicar las migraciones pendientes. El comando crea únicamente `quenda_worker`, concede conexión y uso del esquema `domain` y fija su `search_path`. Las migraciones conceden las funciones operativas. Falla si el rol ya existe o los esquemas no pertenecen al migrador; no reemplaza roles ni contraseñas. Configurar después `WORKER_DATABASE_URL` en el entorno exclusivo del worker. No repetir el bootstrap completo sobre una base existente.

La función recibe explícitamente origen, idioma, duración de concesión, máximo de intentos y espera de reintento. Sus resultados son `IDLE`, `ACCEPTED`, `RETRY_SCHEDULED`, `EXHAUSTED` y `LEASE_LOST`. `ACCEPTED` no garantiza recepción. Un envío aceptado cuyo resultado no llegue a registrarse puede repetirse tras vencer la concesión.

Para ejecutar el worker local: `pnpm worker:local`; añadir `--once` procesa como máximo un evento y termina. Tras `pnpm build`, `pnpm worker:start` ejecuta `dist/email-worker.js` con las variables del entorno. Requiere `WORKER_DATABASE_URL`, `AUTH_ORIGIN` y `EMAIL_LOCALE` (`gl` o `es`). La configuración generada usa gallego; este valor es del proceso, no una preferencia persistida del usuario.

Los parámetros opcionales son `EMAIL_LEASE_SECONDS` (60), `EMAIL_MAX_ATTEMPTS` (5), `EMAIL_RETRY_SECONDS` (60) y `EMAIL_POLL_MS` (1000). Reducir el máximo agota los pendientes que ya lo alcanzan. SIGINT/SIGTERM detienen nuevas iteraciones y cierran el pool tras el intento en curso. Los logs contienen códigos de estado, no destinatarios ni respuestas del proveedor. El transporte local no permite ejecutar el worker con `NODE_ENV=production`.

El worker publica `EMAIL_QUEUE_HEALTH` con cantidades de pendientes, concesiones y agotados al iniciar el procesamiento y, como máximo, una vez por minuto, salvo que un intento agote su límite. Emite `EMAIL_QUEUE_ATTENTION` cuando detecta un total no nulo de agotados distinto del último observado. La alerta también cubre agotamientos por concesión vencida o reducción del límite. Solo el rol worker puede consultar estos contadores; no incluyen identificadores ni destinatarios.

### Idioma de avisos

`GET /api/me/preferences` consulta la preferencia de la cuenta autenticada. `PUT /api/me/preferences`, con `Origin` autorizado, recibe únicamente `{ "locale": "gl" }`, `{ "locale": "es" }` o `{ "locale": null }`. El valor nulo utiliza `EMAIL_LOCALE` del worker. No permite consultar ni modificar otra cuenta.

Cada correo guarda la preferencia del titular al generarse el evento, también cuando la operación la realiza personal municipal. Cambiar la preferencia no altera correos ya pendientes. El worker utiliza ese idioma guardado y solo recurre a su configuración cuando no existe una elección del titular.

### Transporte SMTP

Autenticación y worker utilizan la misma implementación de `MailTransport`. `MAIL_TRANSPORT=local` es el valor predeterminado de desarrollo; `MAIL_TRANSPORT=smtp` permite configurar un servidor sin depender de un proveedor concreto. En producción se exige SMTP y `AUTH_ORIGIN` HTTPS.

SMTP requiere `SMTP_HOST` y `SMTP_FROM` (una dirección). `SMTP_TLS=starttls` exige actualizar la conexión a TLS y usa el puerto 587 por defecto; `SMTP_TLS=tls` inicia con TLS y usa 465. `SMTP_PORT` permite otro puerto. `SMTP_USER` y `SMTP_PASSWORD` se proporcionan juntos cuando el servidor requiere autenticación. `SMTP_SERVERNAME` identifica el certificado y debe indicarse al conectar por IP; `SMTP_CA_FILE` permite una CA privada. Nunca se desactiva la validación del certificado ni se admite degradación a texto plano.

Nodemailer 10.1.7 está fijado en el lockfile e incluye tipos TypeScript y licencia MIT-0. Se utiliza sin pool SMTP, sin logs de protocolo y sin acceso a archivos/URLs desde el contenido del mensaje. Los errores del proveedor se sustituyen por un error genérico. Las pruebas usan servidores SMTP temporales locales con TLS, STARTTLS, autenticación y rechazos; no envían mensajes externos. Configuración basada en la [documentación oficial de Nodemailer](https://nodemailer.com/smtp).

### Indicadores municipales y por unidad

`GET /api/municipalities/{tenantId}/units/{unitId}/indicators?from=2030-01-01&to=2030-02-01` exige `REPORT_READ` sobre la unidad y MFA. El periodo usa fechas locales `[from,to)`, con un máximo de 366 días. Devuelve conteos por estado, minutos reservados, minutos ofertados y porcentaje de ocupación (`null` cuando la oferta es cero), con zona e instante de consulta.

`GET /api/municipalities/{tenantId}/indicators` acepta el mismo periodo y exige `REPORT_READ` municipal y MFA. Incluye todas las unidades, aunque estén retiradas, en una misma transacción y con un único instante de consulta. Suma minutos antes de calcular el porcentaje; no promedia porcentajes por unidad. Un municipio sin unidades devuelve conteos y minutos cero, y porcentaje `null`. Los permisos limitados a unidades no habilitan este total municipal.

La oferta utiliza versiones de calendario y eventos históricos de publicación/retirada de instalación y unidad. Los cierres se recortan a su vigencia efectiva. Dos transiciones contradictorias de publicación con el mismo instante devuelven `409` en vez de inventar un orden. No se devuelven titulares, motivos ni eventos de auditoría. Las respuestas usan `Cache-Control: no-store`.

### Exportación de reservas

`GET /api/municipalities/{tenantId}/exports/reservations?from=2030-01-01&to=2030-02-01` descarga JSON `quenda.reservations`, versión 1. El parámetro opcional `unitId` limita el conjunto a una unidad. Exige `DATA_EXPORT` y `RESERVATION_READ` o `RESERVATION_MANAGE` para el mismo ámbito, con MFA de los últimos cinco minutos. Sin `unitId`, ambos permisos deben ser municipales.

El archivo identifica municipio, unidad solicitada (`null` para todo el municipio), instante de generación, periodo, zona horaria y entidades incluidas. Selecciona reservas que se solapan con `[from,to)` en la zona del municipio; conserva sus intervalos completos, aunque crucen una frontera del periodo. `FINALIZADA` se calcula al generar el archivo y no acredita asistencia. Incluye el identificador del titular, como la consulta municipal ordinaria, pero no nombres, correos ni credenciales. No es una copia de seguridad de la base de datos.

Cada solicitud admite hasta 366 días y 10000 reservas. Si excede el límite, devuelve `400` sin archivo parcial: debe reducirse el periodo o seleccionar una unidad. La respuesta usa `Cache-Control: no-store` y descarga `quenda-reservations-v1.json`.

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

`docker build -t quenda-backend:local .` construye una imagen común para API y workers. `pnpm test:oci` verifica el artefacto local; `QUENDA_IMAGE` permite seleccionar otra etiqueta. La imagen fija Node y el digest de su base, instala con el lockfile y separa compilación de dependencias de producción. El contexto admite únicamente fuentes y archivos necesarios: no incluye `.env`, Git, datos locales ni credenciales. Ejecuta como `node`, sin compilador TypeScript ni herramientas de desarrollo. El digest debe revisarse al actualizar la base; fijarlo no incorpora automáticamente correcciones posteriores. [Recomendaciones de construcción de Docker](https://docs.docker.com/build/building/best-practices/).

El entrypoint es `node`; el comando predeterminado inicia `dist/server.js`. El mismo artefacto admite `dist/email-worker.js`, `dist/monthly-report-worker.js` y `scripts/migrate.ts`. Cada proceso recibe exclusivamente su configuración y credenciales; el proceso API no necesita la URL del migrador ni del worker. La imagen usa `NODE_ENV=production`: API y correo requieren la configuración SMTP y HTTPS ya descrita. No contiene datos de demo ni configura alojamiento.

Las pruebas OCI requieren Docker local y las imágenes oficiales referenciadas por digest. Crean una red interna efímera, sin publicar puertos, y dos bases PostgreSQL con credenciales aleatorias independientes. Ejecutan bootstrap/migraciones desde la imagen, verifican repetición de migraciones, catálogo de dos municipios en una instancia y uno en otra, rechazo de credenciales cruzadas, readiness durante caída/recuperación de PostgreSQL y persistencia tras reiniciar la API. El worker arranca con sus propias credenciales y procesa una cola vacía; esta prueba no verifica entrega SMTP ni sustituye las pruebas de correo. Los datos del catálogo son fixtures sintéticos, no evidencia del recorrido completo de alta por API. Los contenedores, volúmenes temporales, red y archivos privados de configuración se retiran al terminar.

### Copia lógica de PostgreSQL

`PG_BIN=/ruta/postgresql17/bin BACKUP_DATABASE_URL=… pnpm db:backup /directorio-privado/copia.dump` crea un archivo custom de `pg_dump` y devuelve ruta, SHA-256 y duración observada. Proporcionar la URL mediante un mecanismo de secretos, no dejarla en historial de shell. Requiere un rol administrativo de copia con lectura íntegra; no utilizar credenciales web. No activa filtrado RLS ni acepta una copia parcial como completa. Las opciones de conexión admitidas son TLS y `connect_timeout`.

El archivo se prepara con modo `0600`, se sincroniza y solo se publica al terminar sin errores ni diagnósticos de `pg_dump`; un destino existente nunca se reemplaza. El SHA-256 permite comprobar integridad, no cifra ni autentica la copia. El almacenamiento debe tener cifrado, acceso y conservación aprobados para sus datos. Las copias contienen información personal y material de autenticación.

La copia incluye datos, esquemas, permisos e historial de migraciones de una base, no roles globales, contraseñas de roles ni secretos externos. Estos se provisionan por separado en el destino. El formato se restaura con `pg_restore`; una copia debe proceder de una fuente confiable porque puede contener código SQL ejecutable. [Documentación de pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html). El runtime OCI no instala herramientas PostgreSQL: ejecutar este comando en el entorno operativo de copias con el cliente 17 disponible.

`PG_BIN=/ruta/postgresql17/bin node --test test/integration/recovery.test.ts` ensaya la restauración en otro clúster temporal, con contraseñas de roles distintas. Compara cuentas, reservas, ocupaciones, convenios, consumos, eventos, avisos e idempotencia con el corte; comprueba aislamiento, rechazo de credenciales antiguas, replay sin duplicación y cancelación posterior. Informa de tiempos locales y de una reserva creada después de la copia que no se recupera. Son medidas de una fixture pequeña, no un RTO/RPO comprometido. La prueba no abre tráfico ni envía correo desde el destino restaurado.

### Restauración cerrada a la aplicación

`PG_BIN=/ruta/postgresql17/bin RESTORE_ADMIN_DATABASE_URL=… pnpm db:restore /directorio-privado/copia.dump SHA256 nombre_nuevo` verifica una copia privada del archivo y restaura con `pg_restore --single-transaction --exit-on-error`. El checksum debe obtenerse por un canal confiable; no sustituye la comprobación de procedencia del archivo.

El destino debe ser un clúster aislado con los cuatro roles de Quenda provisionados con credenciales propias, sin privilegios elevados ni membresías. El comando requiere un administrador PostgreSQL con capacidad de superusuario: la base se crea con límite de conexiones cero y se revoca el acceso público antes de restaurar. No admite reemplazar una base existente ni ejecuta `DROP` o `--clean`. Si falla después de crearla, la base permanece cerrada para su inspección; no se elimina automáticamente.

El resultado `RESTORED_CLOSED` confirma la carga del archivo, no autoriza tráfico. La API y los workers deben permanecer detenidos hasta verificar migraciones, propietarios, permisos y RLS, conciliar reservas/ocupaciones/consumos y revisar avisos pendientes frente a entregas anteriores al incidente. Solo después de aprobar estas comprobaciones se habilitan las conexiones y los permisos mínimos de cada rol. El comando no realiza esa apertura ni reinicia envíos. La recuperación de un despliegue fallido y el procedimiento operativo completo requieren validación adicional.

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
