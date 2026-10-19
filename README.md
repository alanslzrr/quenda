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

## Primer operador

Crear y verificar una cuenta por la API y completar el alta de TOTP antes de inicializar el operador. Con su identificador de cuenta y las credenciales de mantenimiento:

```sh
pnpm operator:initialize IDENTIFICADOR_DE_CUENTA
```

La operación registra una única inicialización auditable. Rechaza cuentas sin correo verificado o MFA y no puede repetirse aunque el operador se revoque. El proceso web no tiene permisos SQL para asignar ni restaurar operadores. Este permiso operativo no concede acceso general a datos municipales.

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
