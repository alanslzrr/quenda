# Despliegue y operación

Construcción de los artefactos, despliegue de referencia, tareas de mantenimiento, observabilidad y recuperación de una instancia de Quenda. Las decisiones que corresponden a la entidad que opera la instancia (proveedor, capacidad, disponibilidad, RTO y RPO) se recogen en [PD-OPERACION](06_decisiones_y_validacion.md#decisiones-pendientes).

## Imágenes y despliegue

### Imagen OCI

`pnpm image:build quenda-backend:local` construye una imagen común para API y workers desde una revisión Git limpia. El comando crea un archivo de fuentes, extrae de él el contexto de construcción e incorpora el mismo archivo a la imagen. La revisión queda registrada en la etiqueta OCI y la descarga se configura con su SHA-256. No usar un contexto manual distinto para el artefacto que se ofrece a los usuarios. `pnpm test:oci` verifica el artefacto local; `QUENDA_IMAGE` permite seleccionar otra etiqueta. La imagen fija Node y el digest de su base, instala con el lockfile y separa compilación de dependencias de producción. El contexto admite únicamente fuentes y archivos necesarios: no incluye `.env`, Git, datos locales ni credenciales. Ejecuta como `node`, sin compilador TypeScript ni herramientas de desarrollo. El digest debe revisarse al actualizar la base; fijarlo no incorpora automáticamente correcciones posteriores. [Recomendaciones de construcción de Docker](https://docs.docker.com/build/building/best-practices/).

El entrypoint es `node`; el comando predeterminado inicia `dist/server.js`. El mismo artefacto admite `dist/email-worker.js`, `dist/monthly-report-worker.js` y `scripts/migrate.ts`. Cada proceso recibe exclusivamente su configuración y credenciales; el proceso API no necesita la URL del migrador ni del worker. La imagen usa `NODE_ENV=production`: API y correo requieren la configuración SMTP y HTTPS ya descrita. No contiene datos de demo ni configura alojamiento.

Las pruebas OCI requieren Docker local y las imágenes oficiales referenciadas por digest. Crean una red interna efímera, sin publicar puertos, y dos bases PostgreSQL con credenciales aleatorias independientes. Ejecutan bootstrap/migraciones desde la imagen, verifican repetición de migraciones, catálogo de dos municipios en una instancia y uno en otra, rechazo de credenciales cruzadas, readiness durante caída/recuperación de PostgreSQL y persistencia tras reiniciar la API. El worker arranca con sus propias credenciales y procesa una cola vacía; esta prueba no verifica entrega SMTP ni sustituye las pruebas de correo. Los datos del catálogo son fixtures sintéticos, no evidencia del recorrido completo de alta por API. Los contenedores, volúmenes temporales, red y archivos privados de configuración se retiran al terminar.

### Imagen web y despliegue de referencia

`pnpm image:build:web` construye `quenda-web:local` desde la revisión actual. La imagen compila `web/` con el lockfile y sirve únicamente `dist` con nginx sin privilegios (usuario 101, puerto 8080); no incluye mapas de código, herramientas de compilación ni credenciales, y las licencias de las dependencias empaquetadas permanecen en `/licenses`. Nginx devuelve la aplicación para cualquier ruta que no sea un archivo, pero responde 404 a un activo con hash ausente para que la recarga por actualización de versión no reciba HTML. Los activos con hash se sirven con `Cache-Control: public, max-age=31536000, immutable` y `index.html` con `no-cache`.

Las respuestas estáticas llevan `Content-Security-Policy` (`default-src 'self'`, sin `unsafe-eval` ni scripts en línea, `connect-src 'self'`, `frame-ancestors 'none'` y Trusted Types obligatorios con una única política `default` que solo admite la hoja de estilo fija de Radix Select; el servidor de desarrollo envía la misma regla para que las pruebas de navegador fallen ante cualquier otra escritura de HTML), `X-Content-Type-Options`, `X-Frame-Options: DENY` (para navegadores que no aplican `frame-ancestors`), `Referrer-Policy: no-referrer`, `Permissions-Policy`, `Cross-Origin-Opener-Policy` y `Cross-Origin-Resource-Policy`. `Strict-Transport-Security` se emite cuando un proxy de confianza envía `X-Forwarded-Proto: https`, de modo que la terminación TLS corresponde a la entrada del ayuntamiento o a un proxy delante del contenedor. `/api/`, `/health/` y `/legal/source` se dirigen a `QUENDA_API_UPSTREAM` (por defecto `api:3000`), reconstruyen `X-Forwarded-For` con una sola dirección resuelta y `X-Forwarded-Proto` con el protocolo validado y sustituyen las cabeceras de seguridad de la API por una política `default-src 'none'`, con `Cross-Origin-Resource-Policy: same-origin` para que otro sitio no pueda incrustar sus respuestas. Los activos admiten gzip también para HTTP/1.0. La política de contenido envía las infracciones a `/api/csp-reports` (`report-to csp` con `Reporting-Endpoints`, y `report-uri` como alternativa); véase [infracciones de la política de contenido](#infracciones-de-la-política-de-contenido). El cuerpo máximo es 1 MB, 16 KiB para esos informes. `/healthz` responde sin consultar la API.

[compose.production.example.yaml](../compose.production.example.yaml) y [.env.production.example](../.env.production.example) describen una instancia en un único servidor: PostgreSQL 17.11, tarea `bootstrap` (perfil `setup`, una vez), tarea `migrate` previa a la API, API, worker de correo y web. La base y las tareas están en una red interna sin salida; la API y el worker se conectan también a la red de entrada para SMTP. Todos los contenedores de aplicación son de solo lectura, sin capacidades y sin elevación de privilegios. Copiar el archivo de entorno a `.env.production`, restringir su acceso y sustituir cada valor; no guardarlo en Git. Es una referencia para adaptar, no una oferta gestionada: dimensionamiento, almacenamiento de secretos, TLS, copias y monitorización los decide la entidad que opera la instancia ([PD-OPERACION](06_decisiones_y_validacion.md#decisiones-pendientes)).

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

El [despliegue en la nube](13_despliegue_nube.md) automatiza esta composición en una VM: añade Caddy como entrada TLS, genera los secretos en el host y publica cada revisión por SSH.

`TRUSTED_PROXY_CIDRS=172.28.10.10/32` limita la confianza de la API a la dirección fija del contenedor nginx. En nginx, `QUENDA_TRUSTED_PROXY_CIDR` identifica un único CIDR del proxy TLS inmediato; su valor inicial es loopback y debe ajustarse a la dirección real que llega al contenedor, que Docker puede traducir al publicar el puerto. El proxy de entrada debe sanear las cabeceras de cliente. Nginx ignora cabeceras reenviadas de otros pares y resuelve recursivamente la dirección del cliente solo en la cadena confiable; no configurar redes completas de clientes como proxies. `AUTH_ORIGIN` es el origen HTTPS público. `AUTH_CLEAR_SITE_COOKIES=true` añade `Clear-Site-Data: "cookies"` al cerrar sesión; el navegador borra entonces todas las cookies del dominio registrable de `AUTH_ORIGIN`, también las de otros subdominios, por lo que solo se activa si ese dominio sirve únicamente esta instancia. El despliegue en la nube no lo fija y la deja desactivada. Una actualización construye o descarga las imágenes nuevas y repite `up -d`: `migrate` se ejecuta antes de reemplazar la API y, si falla, la API no arranca; aplicar [la recuperación de una actualización fallida](#recuperación-de-una-actualización-fallida). Las copias y restauraciones siguen los procedimientos de [copia lógica](#copia-lógica-de-postgresql) y [restauración cerrada](#restauración-cerrada-a-la-aplicación), ejecutados con el cliente PostgreSQL 17 desde fuera de estos contenedores. `pnpm test:oci` verifica ambas imágenes locales (`QUENDA_IMAGE`, `QUENDA_WEB_IMAGE`) y la integración continua valida además la sintaxis de la composición.

## Operadores de plataforma

### Gestión de operadores

`POST /api/platform/operator-invitations` invita a un correo con `email` y `expiresAt`; no busca cuentas y responde igual exista o no una con esa dirección. `GET` sobre la misma ruta lista las invitaciones para operadores autorizados, con la dirección mientras no se acepta. La cuenta cuyo correo verificado coincide la consulta en `GET /api/me/operator-invitations` y la acepta mediante `POST /api/platform/operator-invitations/{invitationId}/accept`, con MFA reciente. `POST /api/platform/operator-invitations/{invitationId}/revoke` y `POST /api/platform/operators/{accountId}/revoke` requieren `reason`. `GET /api/platform/operators` lista los responsables. La retirada ordinaria no puede dejar la plataforma sin operador habilitado; el permiso no caduca automáticamente.

La recuperación excepcional usa la credencial separada de mantenimiento y exige una verificación externa documentada:

```sh
pnpm operator:recover ACCOUNT_ID PERFORMED_BY AUTHORITY_REFERENCE REASON
pnpm account:recover ACCOUNT_ID PERFORMED_BY IDENTITY_REFERENCE REMEDIATION_REFERENCE REASON
```

`operator:recover` solo actúa después de la inicialización y cuando no quedan operadores habilitados. La cuenta destinataria debe estar activa, verificada y tener MFA. `account:recover` recupera únicamente acceso personal de una cuenta conservada e inactiva; no genera sesiones ni recupera roles. Antes de levantar una suspensión deben sustituirse las credenciales comprometidas mediante el procedimiento controlado: contraseña, secreto MFA y códigos de respaldo si existían. El backend comprueba que sus registros hayan cambiado; la verificación operativa debe acreditar que son credenciales realmente nuevas y controladas por el titular. No se introducen contraseñas, secretos ni documentos completos en argumentos, referencias o registros de auditoría.

### Primer operador

Crear y verificar una cuenta por la API y completar el alta de TOTP antes de inicializar el operador. Con su identificador de cuenta y las credenciales de mantenimiento:

```sh
pnpm operator:initialize IDENTIFICADOR_DE_CUENTA
```

La operación registra una única inicialización auditable. Rechaza cuentas sin correo verificado o MFA y no puede repetirse aunque el operador se revoque. El proceso web no puede modificar directamente las tablas de operadores: utiliza funciones restringidas, autorizadas y auditadas. Este permiso operativo no concede acceso general a datos municipales.

## Procesos de segundo plano

### Procesamiento de correo

`processReservationEmail` reclama un evento con el rol `quenda_worker`, confirma la concesión y envía mediante `MailTransport` fuera de la transacción. Registra aceptación, fallo o vencimiento del intento; los tokens vencidos no pueden confirmar resultados. Los eventos se procesan por reserva y revisión. Agotar los intentos conserva el evento y permite continuar con revisiones posteriores.

El rol worker ejecuta funciones acotadas de entrega de correo, estado de la cola y preparación de informes mensuales; no puede consultar directamente reservas, cuentas o intentos. El bootstrap de bases nuevas lo crea con credenciales independientes; `db:local:config` las guarda en `.env.worker.local`, separado del entorno web. Para una base creada antes de incorporar el worker, configurar `BOOTSTRAP_DATABASE_URL` y una contraseña nueva `WORKER_DATABASE_PASSWORD` de al menos 24 caracteres en `.env.bootstrap.local`; ejecutar `pnpm db:provision:worker` antes de aplicar las migraciones pendientes. El comando crea únicamente `quenda_worker`, concede conexión y uso del esquema `domain` y fija su `search_path`. Las migraciones conceden las funciones operativas. Falla si el rol ya existe o los esquemas no pertenecen al migrador; no reemplaza roles ni contraseñas. Configurar después `WORKER_DATABASE_URL` en el entorno exclusivo del worker. No repetir el bootstrap completo sobre una base existente.

La función recibe explícitamente origen, idioma, duración de concesión, máximo de intentos y espera de reintento. Sus resultados son `IDLE`, `ACCEPTED`, `RETRY_SCHEDULED`, `EXHAUSTED` y `LEASE_LOST`. `ACCEPTED` no garantiza recepción. Un envío aceptado cuyo resultado no llegue a registrarse puede repetirse tras vencer la concesión.

Para ejecutar el worker local: `pnpm worker:local`; añadir `--once` procesa como máximo un evento y termina. Tras `pnpm build`, `pnpm worker:start` ejecuta `dist/email-worker.js` con las variables del entorno. Requiere `WORKER_DATABASE_URL`, `AUTH_ORIGIN` y `EMAIL_LOCALE` (`gl` o `es`). La configuración generada usa gallego; este valor es del proceso, no una preferencia persistida del usuario.

Los parámetros opcionales son `EMAIL_LEASE_SECONDS` (60), `EMAIL_MAX_ATTEMPTS` (5), `EMAIL_RETRY_SECONDS` (60) y `EMAIL_POLL_MS` (1000). Reducir el máximo agota los pendientes que ya lo alcanzan. SIGINT/SIGTERM detienen nuevas iteraciones y cierran el pool tras el intento en curso. Los logs contienen códigos de estado, no destinatarios ni respuestas del proveedor. El transporte local no permite ejecutar el worker con `NODE_ENV=production`.

El worker publica `EMAIL_QUEUE_HEALTH` con cantidades de pendientes, concesiones y agotados al iniciar el procesamiento y, como máximo, una vez por minuto, salvo que un intento agote su límite. Emite `EMAIL_QUEUE_ATTENTION` cuando detecta un total no nulo de agotados distinto del último observado. La alerta también cubre agotamientos por concesión vencida o reducción del límite. Solo el rol worker puede consultar estos contadores; no incluyen identificadores ni destinatarios.

El mismo proceso ejecuta, como máximo una vez por minuto, un lote de conservación y la eliminación acotada de claves de idempotencia vencidas (`IDEMPOTENCY_PURGE`). Un fallo de estas tareas se registra como `RETENTION_BATCH_FAILED` o `IDEMPOTENCY_PURGE_FAILED` y no detiene el envío de correo; la barrera de restauración de privacidad sí detiene el worker.

### Transporte SMTP

Autenticación y worker utilizan la misma implementación de `MailTransport`. `MAIL_TRANSPORT=local` es el valor predeterminado de desarrollo; `MAIL_TRANSPORT=smtp` permite configurar un servidor sin depender de un proveedor concreto. En producción se exige SMTP y `AUTH_ORIGIN` HTTPS.

SMTP requiere `SMTP_HOST` y `SMTP_FROM` (una dirección). `SMTP_TLS=starttls` exige actualizar la conexión a TLS y usa el puerto 587 por defecto; `SMTP_TLS=tls` inicia con TLS y usa 465. `SMTP_PORT` permite otro puerto. `SMTP_USER` y `SMTP_PASSWORD` se proporcionan juntos cuando el servidor requiere autenticación. `SMTP_SERVERNAME` identifica el certificado y debe indicarse al conectar por IP; vacío utiliza `SMTP_HOST`. `SMTP_CA_FILE` permite una CA privada mediante una ruta dentro del proceso. Nunca se desactiva la validación del certificado ni se admite degradación a texto plano.

La composición transmite ambas variables a API y worker. Para montar una CA privada, definir `SMTP_CA_HOST_FILE` como ruta absoluta del certificado y añadir `-f compose.smtp-ca.example.yaml` después de `-f compose.production.example.yaml` en las operaciones Compose. El override monta el certificado de solo lectura en `/run/quenda/smtp-ca.pem` y configura `SMTP_CA_FILE` en ambos servicios.

Nodemailer 10.1.7 está fijado en el lockfile e incluye tipos TypeScript y licencia MIT-0. Se utiliza sin pool SMTP, sin logs de protocolo y sin acceso a archivos/URLs desde el contenido del mensaje. Los errores del proveedor se sustituyen por un error genérico. Las pruebas usan servidores SMTP temporales locales con TLS, STARTTLS, autenticación y rechazos; no envían mensajes externos. Configuración basada en la [documentación oficial de Nodemailer](https://nodemailer.com/smtp).

### Preparación de informes mensuales

```sh
pnpm reports:prepare <convenio-uuid> <AAAA-MM> <revision-actual>
# Con la aplicación compilada y WORKER_DATABASE_URL configurada:
node dist/monthly-report-worker.js <convenio-uuid> <AAAA-MM> <revision-actual>
```

El comando utiliza exclusivamente `quenda_worker`. No requiere configuración de correo ni credenciales del migrador. `revision-actual` es `0` para la primera evaluación; una corrección indica la revisión existente y crea la siguiente sin sobrescribirla. Una revisión obsoleta produce `STALE_VERSION` y código de salida `1`.

El mes debe estar cerrado en la zona del convenio. La evaluación usa su ámbito efectivo, incluye consumos aunque no exista cuota semanal y suprime las métricas si alguna contribución municipal no alcanza diez cuentas distintas. El máximo de procesamiento es 100000 consumos: superar el límite hace fallar la preparación, sin truncar el conjunto ni cambiar el periodo mensual.

La salida contiene únicamente convenio, mes, revisión y corte; no incluye métricas ni sujetos. La evaluación queda almacenada con acceso restringido. Prepararla no autoriza su publicación: la entrega exige las revisiones de riesgo correspondientes y deja constancia del destinatario y de la evaluación entregada.

## Auditoría y métricas

### Auditoría de rechazos

Los rechazos de operaciones propias posteriores a la autenticación se registran en una transacción independiente, incluso si el comando revierte. El registro contiene actor verificado, identificador de petición generado por el servidor, municipio solicitado, operación, resultado e instante. El municipio solicitado no acredita pertenencia ni existencia. No incluye contenido de formularios, cookies ni identificadores de sesión. El rol web solo puede añadir registros asociados al actor transaccional; no puede leerlos, modificarlos ni eliminarlos.

Los rechazos anteriores a la autenticación quedan en el log estructurado sin atribuirles una cuenta. Si falla la persistencia de una auditoría autenticada, la API responde `503 UNAVAILABLE` y registra el fallo sin detalles SQL. Los eventos de operaciones aceptadas permanecen dentro de su transacción de negocio.

### Auditoría de sesiones

`auth.session_event` registra creación y eliminación de sesiones y cambios de la prueba MFA en la misma transacción que la escritura. Conserva únicamente identificador de evento, cuenta afectada, operación e instante; no contiene identificadores de sesión, tokens, IP, agente de usuario ni correo. Los roles de ejecución no pueden consultarlo ni modificarlo directamente. Un fallo al registrar el evento revierte la escritura de sesión.

Son hechos de persistencia: crear una sesión no acredita por sí solo un inicio de sesión con MFA completo, y eliminarla no distingue cierre voluntario, revocación o limpieza. La cuenta afectada no se presenta como actor de la operación. El registro no sustituye la auditoría de intentos fallidos ni define una política de conservación.

`auth.credential_event` registra altas, cambios y retiradas de contraseñas, activación/desactivación MFA y cambios del material TOTP o de recuperación. Solo almacena cuenta afectada, operación, identificador e instante, con las mismas restricciones y atomicidad que los eventos de sesión. No conserva hashes ni valores anteriores o nuevos de los secretos. Un cambio del material de recuperación no distingue por sí solo regeneración de códigos y consumo de un código.

`auth.request_event` registra recepción y resultado HTTP de las operaciones de autenticación expuestas, correlacionados con `x-request-id` generado por el servidor. La operación procede de una lista cerrada; no se almacenan URL, consultas, cuerpos, cookies, errores del proveedor ni respuestas. En operaciones de sesión, el actor procede de una sesión verificada; los flujos públicos y desafíos MFA no se atribuyen al correo o cuenta indicados por el cliente.

`RETURNED` registra el estado HTTP, no acredita por sí solo autenticación completa. `THREW` indica que el proveedor lanzó una excepción. Una recepción sin evento terminal indica resultado no registrado. Si falla la recepción, el proveedor no se ejecuta; si falla el registro final, se devuelve 503 sin entregar la respuesta del proveedor, aunque este puede haber confirmado cambios. Los eventos transaccionales de sesión y credenciales permiten comprobar esos cambios; no se promete atomicidad entre Better Auth y el registro HTTP. Las consultas de sesión/esquema y los rechazos previos al despacho HTTP no generan este registro.

### Auditoría de consultas municipales de reservas

Las páginas municipales registran cada reserva devuelta; la consulta de detalle registra el acceso cuando quien consulta no es el titular. El registro contiene municipio, reserva, actor, operación, correlación de la solicitud y fecha, sin copiar datos de la reserva ni credenciales. La consulta y la auditoría comparten transacción: si falla el registro, no se devuelve la información. El registro vuelve a comprobar y bloquear el permiso vigente por unidad antes de confirmar.

Los roles de API, autenticación y worker no pueden leer, alterar ni borrar directamente esta auditoría. Las consultas personales del titular no se convierten en accesos de soporte. Para una intervención municipal se utilizan permisos delegados de alcance mínimo y con caducidad; no existe un permiso global de soporte ni una excepción al aislamiento. La autorización y revocación conservan sus eventos de delegación. La conservación y consulta operativa de estas evidencias siguen sujetas a la política aprobada del despliegue.

### Infracciones de la política de contenido

La API registra cada informe de infracción recibido en `POST /api/csp-reports` como un evento `CSP_VIOLATION` de nivel `warn` en su log estructurado. No se guarda en la base de datos. Campos:

| Campo | Contenido |
|---|---|
| `directive` | Directiva infringida, por ejemplo `img-src`, `script-src-elem` o `require-trusted-types-for`. |
| `blocked` | Origen del recurso bloqueado (`https://cdn.example.test`), una palabra clave del navegador (`inline`, `eval`, `wasm-eval`, `trusted-types-sink`, `trusted-types-policy`) o solo el esquema (`data:`, `blob:`, `chrome-extension:`). `other` si no es una URL; `null` si no se indicó. |
| `documentPath` | Ruta de la página, sin consulta ni fragmento. |
| `disposition` | `enforce` (bloqueado) o `report` (solo informado); `null` si el navegador no la envía. |
| `status` | Estado HTTP de la página; `null` si no se indicó. |
| `reqId` | Identificador de la petición, igual a `x-request-id`. |

```json
{"level":40,"time":1794948334304,"reqId":"a5ff8ddd-a386-469b-b606-afabc00782c8","event":"CSP_VIOLATION","directive":"img-src","blocked":"https://images.example.test","documentPath":"/municipios/ejemplo","disposition":"enforce","status":200,"msg":"Content security policy violation"}
```

Para agruparlos en el despliegue en la nube, por ejemplo: `sudo quenda compose logs --no-log-prefix --since 24h api | grep '"CSP_VIOLATION"' | jq -c '{directive, blocked, documentPath}' | sort | uniq -c | sort -rn`; con la composición de referencia, el mismo `docker compose … logs` sobre el servicio `api`. Un mismo `blocked` repetido en muchas páginas tras un despliegue suele indicar que la política no recoge un recurso legítimo; orígenes desconocidos en `script-src` o `trusted-types-sink` pueden indicar una extensión del navegador o un intento de inyección. Los informes los genera el navegador del visitante y cualquiera puede enviarlos sin sesión: no acreditan por sí solos un ataque ni su ausencia. Los informes sobre páginas de otro origen se descartan sin registro. Un cuerpo inválido, mayor de 16 KiB o con otro tipo de contenido se rechaza sin registrar su contenido; al superar 60 peticiones por minuto y dirección se responde `429`. La conservación del log sigue la del resto de registros del despliegue.

### Métricas de base de datos

La API emite `DATABASE_METRICS` cada 30 segundos mediante su logger (`info`). Para cada pool publica conexiones totales, libres y solicitudes en espera. Los contadores de `commands` cubren únicamente operaciones ejecutadas mediante `command`: iniciadas, activas, confirmadas, fallidas, reintentos, fallos de serialización e interbloqueos. Un fallo reintentado no cuenta como comando fallido si el intento posterior confirma.

La duración acumulada y máxima se expresan en milisegundos e incluyen espera de conexión y backoff del comando completo. Son acumulados locales que se reinician con el proceso, no percentiles ni métricas globales entre réplicas. Las consultas directas de Better Auth no pasan por este ejecutor. Los registros no llevan cuentas, municipios, SQL ni credenciales como etiquetas. El temporizador se elimina al cerrar la API y no mantiene vivo el proceso por sí solo.

`retryExhaustions` cuenta comandos que terminan tras agotar reintentos por serialización o interbloqueo. En cada muestreo, `DATABASE_RETRY_EXHAUSTED` (`warn`) informa del incremento y del total por pool. No repite el aviso si el contador no cambia ni lo activa por un rechazo funcional. La detección tiene la cadencia de 30 segundos; no sustituye un sistema externo de recepción de alertas.

### Métricas HTTP

La API emite `HTTP_METRICS` cada 30 segundos con acumulados locales de solicitudes terminadas: `read` agrupa GET/HEAD y `write` los demás métodos. Incluye respuestas correctas, redirecciones, errores de cliente y servidor, duración total y máxima, y un histograma de latencia. Cada solicitud incrementa un único intervalo; `bucketUpperBoundsMs` indica sus límites superiores inclusivos y `+Inf` recoge el resto. No son percentiles exactos ni métricas exclusivas de comandos válidos: incluyen autenticación, salud y solicitudes rechazadas.

`HTTP_SERVER_ERRORS` registra únicamente los nuevos errores 5xx desde el informe anterior. No convierte respuestas 4xx en fallos del servidor ni repite alertas sin errores nuevos. Los contadores se reinician con el proceso; no incluyen ruta, parámetros, cuerpo, cuentas ni municipio y tienen tamaño fijo. El temporizador se elimina al cerrar la API. La agregación entre réplicas, los umbrales operativos y el destino de las alertas pertenecen a la configuración del despliegue.

## Copias, restauración y recuperación

### Fotografías del catálogo

Las fotografías se guardan en PostgreSQL (`domain.catalog_photo`): cada una ocupa unos 150–300 KB entre sus dos tamaños WebP. Seis fotos por instalación y por espacio suman unos pocos megabytes por instalación. Entran en la copia lógica y en la restauración como el resto de datos, sin ningún almacenamiento adicional.

El nginx de la imagen web mantiene el límite de 1 MiB por petición y admite 9 MiB solo en la ruta de subida de fotos. Un proxy de entrada propio debe permitir el mismo tamaño en esa ruta (`/api/municipalities/{id}/{facilities|units}/{id}/photos`). La API procesa como máximo dos imágenes a la vez por proceso.

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

### Recuperación sin rehabilitar datos suprimidos

```sh
pnpm privacy:checkpoint /directorio-privado/privacidad.json
RESTORE_ADMIN_DATABASE_URL=… pnpm privacy:restore-reconcile /directorio-privado/privacidad.json SHA256 REFERENCIA_AUTORIZACION
```

El checkpoint utiliza credenciales de mantenimiento, un destino nuevo con modo `0600` y un checksum. Contiene referencias de actuaciones y excepciones, no contenidos bloqueados ni secretos. Debe conservarse fuera de las copias antiguas y actualizarse mediante el procedimiento operativo de respaldo. Su procedencia y actualidad se comprueban por separado: un hash no demuestra que el archivo sea el último. La ausencia de evidencia actual impide autorizar la reapertura.

`db:restore` activa `restore_review_required`, además de cerrar conexiones. API y workers rechazan el arranque mientras esté activo, aunque se hayan vuelto a conceder permisos de conexión. La conciliación de privacidad reproduce eliminaciones y bloqueos del checkpoint, conserva su evidencia para futuras copias y deja las políticas restauradas desactivadas para revisión. No abre el servicio ni presume resueltos conflictos de conservación.

El responsable operativo debe verificar el checkpoint más reciente, resolver diferencias con los responsables del tratamiento, revisar políticas y excepciones y completar `db:reconcile` antes de retirar la barrera de recuperación mediante mantenimiento autorizado. Los comandos no realizan esa autorización. El diario contiene referencias personales; su retirada se coordina con la caducidad de las copias recuperables y la política de conservación, no con una eliminación automática por antigüedad arbitraria.

## Licencias y código fuente

### Inventario de licencias de dependencias

`pnpm --silent licenses:inventory > /directorio-privado/licencias.json` recorre el grafo de dependencias de pnpm, distingue runtime y desarrollo y registra licencia declarada, archivos de evidencia y sus SHA-256. Incluye textos de licencia presentes en README; una mención o enlace no cuenta como texto. No depende del índice de `pnpm licenses`. Las entradas no instaladas, incluidas variantes de plataforma, se enumeran por separado. No incluye las licencias del sistema operativo ni de la imagen base.

El código de salida 2 indica evidencia pendiente; 1 indica que no pudo terminar el inventario. `EVIDENCE_COLLECTED` solo confirma recopilación, no compatibilidad jurídica ni cumplimiento de atribuciones. Revisar los textos y avisos de cada versión antes de distribuirla; conservarlos también en el artefacto. La compatibilidad y las obligaciones de acceso al código fuente se contrastan con la [guía de GNU sobre licencias](https://www.gnu.org/licenses/license-list.html) y la [explicación de la AGPL](https://www.gnu.org/licenses/why-affero-gpl.html). La oferta debe corresponder a la versión ejecutada, incluidas sus modificaciones; el inventario no implementa ni verifica esa entrega.

### Archivo de código fuente de una revisión

`pnpm --silent source:archive /directorio-privado/quenda-source.tar.gz` empaqueta `HEAD` en un destino nuevo y devuelve revisión, SHA-256 y número de archivos. Requiere un árbol limpio: incluye código, migraciones, scripts, configuración de construcción, lockfile, licencia y demás archivos versionados; no incluye `.git`, archivos ignorados ni dependencias instaladas. Rechaza enlaces, submódulos, atributos de exportación y nombres restringidos de secretos o datos. Esta comprobación de nombres no sustituye la revisión del contenido antes de distribuirlo.

Conservar el archivo junto al artefacto construido desde esa misma revisión. No asociarlo a una imagen creada desde cambios pendientes ni a una versión distinta. El comando no publica el archivo, no crea una URL y no demuestra por sí solo que esté completo el código fuente correspondiente de terceros. Antes de un despliegue sujeto a AGPL, completar las atribuciones y proporcionar acceso gratuito al código fuente correspondiente a la versión ejecutada, incluidos los cambios y elementos de construcción necesarios. Verificar la descarga desde la perspectiva del usuario; una referencia a la rama principal no identifica por sí sola esa versión.

La API ofrece `GET /legal/source` sin autenticación. Configurar conjuntamente `SOURCE_ARCHIVE_PATH`, `SOURCE_ARCHIVE_SHA256` y `SOURCE_REVISION` con el archivo y recibo anteriores; el archivo debe estar disponible en el entorno de ejecución. El arranque verifica tamaño máximo de 16 MiB, formato gzip y checksum, y conserva los bytes verificados para que un reemplazo posterior del archivo no cambie la descarga. Un error de configuración impide el arranque sin exponer rutas ni contenido en el mensaje.

La respuesta incluye revisión, SHA-256, ETag y nombre del archivo. Las respuestas de la API anuncian la descarga mediante una cabecera `Link`; no depende de la base de datos ni crea sesiones. Sin configuración responde 503 y no anuncia una oferta inexistente. Antes de distribuir o desplegar, verificar que el archivo corresponde al artefacto y que el usuario puede descargarlo; estas variables no demuestran por sí solas esa correspondencia ni resuelven las atribuciones pendientes. La aplicación web ofrece la descarga en el aviso legal, dentro de «Propiedad intelectual», en lugar de un enlace directo en el pie de página.
