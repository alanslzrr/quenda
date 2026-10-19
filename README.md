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

`AUTH_ORIGIN` fija el origen permitido y `AUTH_SECRET` se genera con la configuración local. El registro exige verificar el correo antes de iniciar sesión. Los mensajes de verificación y recuperación se guardan en `.local/mail`, con permisos privados y fuera de Git. Este transporte no envía correo y no admite ejecución en producción.

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

La creación valida las reglas vigentes y confirma reserva, ocupación, evento, avisos y resultado idempotente en una sola transacción. Un conflicto no deja cambios parciales. El correo queda pendiente; todavía no hay worker de entrega. La disponibilidad pública descuenta las ocupaciones confirmadas, pero no garantiza que una franja siga libre al reservar.

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

El rol worker solo ejecuta las funciones de reclamar y finalizar; no puede consultar directamente reservas, cuentas o intentos. El bootstrap de bases nuevas lo crea con credenciales independientes; `db:local:config` las guarda en `.env.worker.local`, separado del entorno web. Una base creada con un bootstrap anterior requiere provisionar ese rol antes de aplicar la migración 0043; no se debe repetir el bootstrap sobre ella.

La función recibe explícitamente origen, idioma, duración de concesión, máximo de intentos y espera de reintento. Sus resultados son `IDLE`, `ACCEPTED`, `RETRY_SCHEDULED`, `EXHAUSTED` y `LEASE_LOST`. `ACCEPTED` no garantiza recepción. Un envío aceptado cuyo resultado no llegue a registrarse puede repetirse tras vencer la concesión.

Para ejecutar el worker local: `pnpm worker:local`; añadir `--once` procesa como máximo un evento y termina. Tras `pnpm build`, `pnpm worker:start` ejecuta `dist/email-worker.js` con las variables del entorno. Requiere `WORKER_DATABASE_URL`, `AUTH_ORIGIN`, `LOCAL_MAIL_DIR` y `EMAIL_LOCALE` (`gl` o `es`). La configuración generada usa gallego; este valor es del proceso, no una preferencia persistida del usuario.

Los parámetros opcionales son `EMAIL_LEASE_SECONDS` (60), `EMAIL_MAX_ATTEMPTS` (5), `EMAIL_RETRY_SECONDS` (60) y `EMAIL_POLL_MS` (1000). Reducir el máximo agota los pendientes que ya lo alcanzan. SIGINT/SIGTERM detienen nuevas iteraciones y cierran el pool tras el intento en curso. Los logs contienen códigos de estado, no destinatarios ni respuestas del proveedor. El transporte local no permite ejecutar el worker con `NODE_ENV=production`.

El worker publica `EMAIL_QUEUE_HEALTH` con cantidades de pendientes, concesiones y agotados al iniciar el procesamiento y, como máximo, una vez por minuto, salvo que un intento agote su límite. Emite `EMAIL_QUEUE_ATTENTION` cuando detecta un total no nulo de agotados distinto del último observado. La alerta también cubre agotamientos por concesión vencida o reducción del límite. Solo el rol worker puede consultar estos contadores; no incluyen identificadores ni destinatarios.

### Idioma de avisos

`GET /api/me/preferences` consulta la preferencia de la cuenta autenticada. `PUT /api/me/preferences`, con `Origin` autorizado, recibe únicamente `{ "locale": "gl" }`, `{ "locale": "es" }` o `{ "locale": null }`. El valor nulo utiliza `EMAIL_LOCALE` del worker. No permite consultar ni modificar otra cuenta.

Cada correo guarda la preferencia del titular al generarse el evento, también cuando la operación la realiza personal municipal. Cambiar la preferencia no altera correos ya pendientes. El worker utiliza ese idioma guardado y solo recurre a su configuración cuando no existe una elección del titular.
