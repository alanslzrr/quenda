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

## Gestores municipales

`POST /api/municipalities/{tenantId}/manager-invitations` recibe `accountId`, `expiresAt`, `roleExpiresAt` opcional y `permissions: [{ operation, unitId }]`. El administrador invita; el destinatario acepta con MFA mediante `/{invitationId}/accept`. `/{invitationId}/revoke` revoca la invitación o concesión con `{ "reason": "..." }`.

`GET /api/me/manager-invitations` devuelve las invitaciones y concesiones de la cuenta autenticada, con sus permisos y estado. Devuelve hasta 20 elementos y `nextCursor`; la página siguiente utiliza `?after=...`. No admite consultas de otra cuenta.

Para sustituir una concesión, la nueva invitación incluye `replacesInvitationId` y `reason`. La concesión anterior permanece activa hasta la aceptación: esta activa los nuevos permisos y revoca los anteriores en una sola transacción auditada. Las demás concesiones independientes no cambian. Si es necesario retirar acceso inmediatamente, se utiliza la revocación; no se espera a la aceptación de una sustitución.

`GET /api/municipalities/{tenantId}/manager-invitations` permite al administrador con MFA reciente consultar las invitaciones y concesiones del municipio. Incluye destinatario, emisor, permisos, referencia de sustitución y fechas de vencimiento, aceptación y revocación. Devuelve hasta 20 elementos y `nextCursor`; la página siguiente utiliza `?after=...`. Las fechas describen el historial y no sustituyen la comprobación de autoridad vigente de cada operación.

Cada permiso se limita a una operación y unidad real del municipio; `unitId: null` abarca el municipio. `CATALOG_CREATE` exige ámbito municipal. Las operaciones admitidas son `CATALOG_CREATE`, `CATALOG_MANAGE`, `RESERVATION_READ`, `RESERVATION_MANAGE`, `UNIT_BLOCK`, `REPORT_READ` y `DATA_EXPORT`. Ninguna concede administración de cuentas. Las altas del catálogo ya aplican este control; el resto se integrará al implementar sus respectivos módulos.

## Catálogo en borrador

`POST /api/municipalities/{tenantId}/facilities` crea una instalación; `POST /api/municipalities/{tenantId}/facilities/{facilityId}/units` crea una unidad. Ambos reciben `{ "name": "..." }`, requieren el permiso municipal `CATALOG_CREATE` y MFA reciente y registran auditoría. Las altas persisten como borradores: no publican recursos ni permiten reservarlos.

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
