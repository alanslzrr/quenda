# Referencia de la API HTTP

Descripción funcional de las rutas HTTP de Quenda, agrupadas por área. El contrato formal es el documento OpenAPI 3 que genera `pnpm --silent openapi` sin necesidad de una base de datos activa; la API publica también el de autenticación en `GET /api/auth/open-api/generate-schema`. Las reglas de negocio que justifican cada comportamiento están en la [especificación técnica](README.md).

## Errores y conflictos

Los errores responden `{ "error": { "code", "message" }, "requestId" }`. `message` se redacta en gallego o castellano según `Accept-Language`, y la web lo muestra tal cual. Cuando el estado actual impide una operación, la respuesta es `409` con un código que nombra la causa; ninguno enumera reservas, cuentas ni datos de otros municipios. Los rechazos de reservas tienen sus propios códigos (véase [Confirmación de reservas](#confirmación-de-reservas)).

| Código | Causa | Cómo continuar |
|---|---|---|
| `STALE_VERSION` | Otra persona, u otra pestaña, guardó antes una versión nueva de lo que se edita: ficha, calendario, normas, política de reserva, apariencia, nombre o logo, textos legales, ajustes de analítica, orden de fotografías, publicación con calendario anterior, versión de convenio, evaluación o revisión mensual, o revisión de conservación compartida. | Recargar para ver la versión actual y volver a aplicar el cambio. |
| `SCHEDULE_HAS_RESERVATIONS` | El calendario nuevo dejaría sin cobertura reservas confirmadas pendientes o en curso. | Cancelar o reubicar esas reservas, o ampliar el horario. |
| `UNIT_ADVANCE_EXCEEDS_LIMIT` | La política de reserva bajaría la antelación municipal por debajo de la antelación explícita del calendario de alguna unidad. | Reducir antes esa antelación en los calendarios. |
| `FACILITY_NOT_PUBLISHED` | Se publica una unidad cuya instalación no está publicada o está retirada. | Publicar antes la instalación. |
| `FACILITY_WITHDRAWN` | Se crea una unidad en una instalación retirada. | Volver a publicar la instalación. |
| `CATALOG_NOT_EMPTY` | Se importa un catálogo en un municipio que ya tiene instalaciones. | Modificar el catálogo existente. |
| `ARRIVAL_OUTSIDE_WINDOW` | Se registra una llegada fuera de su ventana o de una reserva no confirmada. | Registrarla desde 30 minutos antes del inicio hasta el final. |
| `AGREEMENT_STATE_CONFLICT` | El estado del convenio no admite la operación: versión que no puede aprobarse, activarse o suspenderse, aprobaciones o vigencia insuficientes, unidades no coincidentes o ya vinculadas, o restricción con adscripciones. | Recargar y revisar versión, aprobaciones y vigencia. |
| `ROLE_ALREADY_ACTIVE` | La dirección ya tiene una invitación de operador pendiente, la cuenta que acepta ya es operadora o ya es administradora al aceptar la invitación. | Recargar para ver su estado. |
| `MUNICIPALITY_ALREADY_INITIALIZED` | Se sustituye la invitación inicial de un municipio que ya tuvo administrador. | Usar la recuperación si no queda ningún responsable habilitado. |
| `ADMINISTRATOR_RECOVERY_UNAVAILABLE` | Se recupera un municipio con administrador habilitado o sin alta inicial completada, o el destinatario no está habilitado. | Recargar para ver su estado. |
| `EMAIL_ADDRESS_UNAVAILABLE` | La dirección ya no puede asignarse al confirmar el cambio de correo. | Solicitar el cambio con otra dirección. |
| `CONFLICT` | Casos residuales: contención que agota los reintentos de serialización, una carrera al consumir un código de respaldo, transiciones históricas contradictorias o la publicación de una unidad sin calendario por API. | Recargar para ver el estado actual y repetir si procede. |

La auditoría de accesos rechazados registra todos estos códigos con el resultado `CONFLICT`.

## Autenticación local

Better Auth utiliza el esquema `auth`, con migraciones ejecutadas fuera del proceso web. Kysely configura su adaptador PostgreSQL con transacciones; las consultas del dominio utilizan `pg`.

`AUTH_ORIGIN` fija el origen permitido y `AUTH_SECRET` se genera con la configuración local. El registro exige verificar el correo antes de iniciar sesión. Con el transporte local, los mensajes de verificación y recuperación se guardan en `.local/mail`, con permisos privados y fuera de Git. Este transporte no envía correo y no admite ejecución en producción.

Las rutas habilitadas están bajo `/api/auth`; `GET /api/auth/open-api/generate-schema` devuelve su contrato OpenAPI. `GET /api/me` devuelve la identidad verificada y si la sesión ha superado MFA. Las cookies son Secure, HttpOnly y SameSite=Lax; fuera del desarrollo en loopback se requiere HTTPS. La autenticación no concede permisos municipales.

`POST /api/auth/sign-out` revoca la sesión y responde con `Set-Cookie` que caduca las cookies de sesión. Si `AUTH_CLEAR_SITE_COOKIES=true`, una respuesta `200` incluye también `Clear-Site-Data: "cookies"`; las respuestas de error nunca la incluyen. La directiva no afecta al almacenamiento local, pero el navegador la aplica a todas las cookies del dominio registrable, incluidos otros subdominios; véanse [sesiones](05_seguridad_y_cumplimiento.md#sesiones-y-protección-de-peticiones) y [operación](12_operacion.md). Solo admite `true` o `false` (por defecto); otro valor impide arrancar la API.

## Administración municipal por API

`POST /api/municipalities` recibe `name`, `timezone`, `administratorEmail` e `invitationExpiresAt` (ISO 8601). Requiere una sesión del operador con MFA y devuelve `tenantId` e `invitationId`. El alta no concede permisos todavía.

### Invitaciones dirigidas a un correo

Las invitaciones que conceden autoridad —primer administrador (`administratorEmail`), administradores y gestores, sustitución de la invitación inicial, recuperación, operadores de plataforma y privacidad global (`email`)— se dirigen a una dirección de correo, no a un identificador de cuenta. La API recorta espacios, pasa la dirección a minúsculas y valida su formato; una dirección mal formada responde `400 INVALID_INPUT`. Al crearla no se consulta ninguna cuenta: la respuesta tiene el mismo estado, la misma forma (`tenantId` e `invitationId`; solo `invitationId` en las invitaciones de plataforma) y un coste comparable exista o no una cuenta con ese correo, y nunca devuelve nombres ni identificadores de cuentas, como ocurre en el registro. Quenda envía a la dirección un aviso con el rol, el municipio o la plataforma, el plazo de aceptación y un enlace a `{AUTH_ORIGIN}/perfil/invitaciones`, sin tokens: la aceptación sigue haciéndose en la aplicación, con esa dirección verificada y MFA. El aviso es el mismo exista o no una cuenta, no nombra al emisor y se encola en la misma transacción que la invitación; revocarla, sustituirla, aceptarla o retirar su dirección antes del envío lo cancela, y una invitación vencida no se envía. Las sustituciones de alcance de un gestor no generan aviso. Cada municipio, y la plataforma, encolan como máximo 100 avisos en 24 horas; por encima la invitación se crea igual, sin aviso, y la respuesta no cambia.

La invitación aparece en `GET /api/me/administrator-invitations`, `GET /api/me/manager-invitations`, `GET /api/me/operator-invitations` o `GET /api/me/privacy-invitations` de la cuenta cuyo correo verificado coincide con la dirección, y solo esa cuenta puede aceptarla. La aceptación mantiene el MFA reciente, el vencimiento, la revocación, las reglas de sustitución y el uso único, y vuelve a comparar el correo verificado actual: si una cuenta cambia de correo antes de aceptar, la invitación sigue a la dirección y no a la cuenta. Una cuenta sin el correo verificado, o con otro correo, recibe `404` al aceptar. Al aceptarla, la invitación queda vinculada a la cuenta que la aceptó y deja de conservar la dirección. Las invitaciones creadas antes de este cambio siguen dirigidas a su cuenta y pueden aceptarse igual que antes.

El destinatario acepta con MFA mediante `POST /api/municipalities/{tenantId}/administrator-invitations/{invitationId}/accept` y cuerpo `{}`. Ambas operaciones requieren la cookie de sesión y el encabezado `Origin` exactamente igual a `AUTH_ORIGIN`; rechazan campos adicionales. El contrato generado por `pnpm openapi` incluye estas rutas y `/api/me` sin necesitar una base activa.

La prueba MFA para estas operaciones caduca a los cinco minutos. La API responde `403` con `REAUTHENTICATION_REQUIRED`; verificar de nuevo mediante `POST /api/auth/two-factor/verify-totp` permite repetir la operación sin cerrar la sesión. Un intento incorrecto no renueva la prueba y mantiene los límites de intentos de Better Auth.

Las operaciones autenticadas tienen dos límites por cuenta en ventanas de 60 segundos: 600 lecturas (`GET`) y 120 operaciones que cambian datos. Son independientes, de modo que consultar pantallas no agota el margen para actuar. Los intentos consumen cuota aunque la operación se rechace; al agotarse, la respuesta es `429 RATE_LIMITED` con `Retry-After`. `GET /api/me` y `GET /api/me/notices/unread` solo leen la sesión y no consumen ninguno de los dos. Los límites de autenticación y TOTP son independientes.

Un administrador con MFA reciente puede invitar mediante `POST /api/municipalities/{tenantId}/administrator-invitations` (`email`, `expiresAt`) y revocar una invitación pendiente mediante `POST /api/municipalities/{tenantId}/administrator-invitations/{invitationId}/revoke` (`{}`). La aceptación comprueba también que el emisor conserva su autorización; revocar una invitación aceptada no retira el rol ya concedido.

El rol se revoca con `POST /api/municipalities/{tenantId}/administrators/{accountId}/revoke` y `{ "reason": "..." }`. La revocación conserva perfil e historial, registra el motivo e invalida las invitaciones pendientes emitidas por ese administrador. Para recuperar el rol debe aceptar una nueva invitación emitida después de la revocación; las invitaciones anteriores no se reactivan.

`GET /api/me/administrator-invitations` devuelve las invitaciones de la cuenta autenticada —las dirigidas a su correo verificado actual y las vinculadas a la cuenta—, con municipio, vencimiento y estado. Devuelve hasta 20 elementos y `nextCursor`; la página siguiente utiliza `?after=...`. No admite filtros por otra cuenta ni requiere MFA para consultar las invitaciones propias.

El operador puede sustituir una invitación inicial caducada o incorrecta con `POST /api/municipalities/{tenantId}/initial-administrator-invitation/replace` (`email`, `expiresAt`, `reason`) y MFA reciente; responde `201` con `tenantId` e `invitationId`, la misma respuesta exista o no una cuenta con esa dirección. La sustitución invalida las invitaciones iniciales pendientes, cancela su aviso por correo si aún no se había enviado y conserva su auditoría; la nueva invitación encola su propio aviso. Esta vía se cierra después de la primera aceptación y no se reabre al revocar administradores: a partir de entonces responde `409 MUNICIPALITY_ALREADY_INITIALIZED`. Un municipio inexistente responde `404`.

Al invitar a un administrador, `roleExpiresAt` permite fijar la caducidad del rol; es independiente de `expiresAt`, que limita la aceptación. Omitirlo o enviar `null` concede el rol sin vencimiento temporal, sujeto a revocación. Un permiso vencido no autoriza operaciones ni nuevas aceptaciones de sus delegaciones; renovarlo requiere otra invitación y no reactiva las anteriores. Un administrador con permiso temporal solo puede conceder roles de administrador que venzan, como máximo, cuando vence el suyo (`403 FORBIDDEN` en otro caso).

`GET /api/public/municipalities/{tenantId}/branding` devuelve el nombre visible, el nombre oficial de alta, los logos disponibles y una `version` que cambia con cada cambio de nombre o logo. `GET /api/public/municipalities/{tenantId}/logo/{light|dark}` sirve el logo en WebP con `ETag`. Con administración municipal y MFA reciente, `PUT /api/municipalities/{tenantId}/branding/name` (`expectedVersion`, `name`) cambia el nombre visible; `PUT /api/municipalities/{tenantId}/branding/logos/{light|dark}` (`expectedVersion`, `image` en base64, PNG, JPEG o WebP de hasta 2 MiB) guarda la recodificación del servidor, y `DELETE` con `?expectedVersion=` lo quita (quitar el principal quita también el oscuro). Una versión obsoleta responde `409 STALE_VERSION`; un formato no admitido, incluido SVG, `400 LOGO_INVALID`.

`GET /api/public/municipalities/{tenantId}/appearance` devuelve el tema (`theme`), los ajustes de color por modo (`light`, `dark`: `background`, `foreground`, `accent` en `#rrggbb`), `font`, `corners` y `defaultTheme`. `PUT /api/municipalities/{tenantId}/appearance` los guarda con `expectedVersion`, administración municipal y MFA reciente; rechaza temas fuera del catálogo y combinaciones sin contraste suficiente. Una versión obsoleta responde `409 STALE_VERSION`.

`GET /api/municipalities/{tenantId}/profiles` permite al administrador con MFA reciente consultar los perfiles vinculados a ese municipio. Devuelve `accountId`, `createdAt` y `accountLabel` (nombre y correo de presentación), hasta 20 elementos y `nextCursor`; la página siguiente utiliza `?after=...`. No incluye cuentas sin vínculo municipal ni credenciales; la proyección de nombre y correo está limitada al ámbito autorizado. Los gestores y operadores sin rol administrativo en ese municipio no pueden utilizar esta consulta.

`GET /api/municipalities/{tenantId}/administrators` muestra la última asignación administrativa de cada cuenta, su invitación de origen, vigencia, revocación y estado `active` al consultar. `GET /api/municipalities/{tenantId}/administrator-invitations` muestra el historial de invitaciones, incluida su aceptación: `recipientEmail` es el correo de una invitación sin aceptar y `accountId`, con `accountLabel`, la cuenta que la aceptó o a la que se dirigía una invitación anterior; ambos son `null` si la conservación ya retiró la dirección de una invitación no aceptada. Ambas consultas requieren administración municipal y MFA reciente; devuelven hasta 20 elementos y `nextCursor`. Una invitación aceptada no acredita autoridad actual: una revocación o renovación puede haber cambiado la asignación.

## Nombre de la cuenta

`POST /api/auth/update-user` recibe exclusivamente `{ "name": "..." }` y modifica el nombre del titular de la sesión. El nombre admite hasta 200 caracteres, se guarda sin espacios exteriores y no puede quedar vacío ni contener caracteres de control. La operación no modifica el correo, la verificación, el MFA ni los permisos. El nombre actualizado se consulta mediante `GET /api/auth/get-session`. Cambiar el nombre no acredita una identidad legal.

## Baja y reactivación de cuenta

`POST /api/me/deactivation` recibe `{ "confirm": true, "password": "..." }`. Exige sesión, `Origin` autorizado y contraseña actual. Con MFA habilitado, la verificación del segundo factor debe tener menos de cinco minutos. Rechaza reservas confirmadas futuras o en curso de cualquier municipio (`409 ACCOUNT_HAS_FUTURE_RESERVATIONS`) y dejar una última responsabilidad sin sustituto habilitado indefinido (`409 ACCOUNT_HANDOVER_REQUIRED`).

La baja revoca sesiones, permisos propios e invitaciones pendientes recibidas y emitidas, sin retirar permisos ya aceptados por otros usuarios. Conserva identidad, perfiles, reservas y auditoría. No elimina datos personales ni cancela reservas.

`POST /api/account/reactivation/request` recibe `email` y `password`; responde `202` sin revelar la existencia o estado de la cuenta. Si procede, envía un enlace de un solo uso, válido diez minutos. `POST /api/account/reactivation/confirm` recibe `token`, `password` y `totpCode` o `backupCode` —nunca ambos— cuando había MFA. El código de respaldo se consume con la reactivación. Permite cinco intentos por prueba, además de límites compartidos por IP y cuenta. La confirmación devuelve `REACTIVATED`; no emite sesión ni recupera permisos administrativos. El usuario inicia sesión de nuevo. No permite recuperar cuentas suprimidas ni levantar suspensiones.

## Continuidad y seguridad administrativa

- `POST /api/municipalities/{tenantId}/administrators/{accountId}/make-indefinite`, con `reason`, convierte un permiso temporal vigente ya aceptado en indefinido. Solo puede hacerlo un administrador con permiso indefinido, y nunca sobre su propio permiso. La revocación ordinaria exige otro responsable habilitado indefinido.
- `POST /api/municipalities/{tenantId}/accounts/{accountId}/revoke-access-for-security`, con `reason`, retira permisos e invitaciones pendientes solo en ese municipio, incluso los del último administrador, y también las invitaciones pendientes dirigidas a su correo verificado. Requiere administrador municipal con MFA reciente. La interfaz ofrece las cuentas de las propias tablas de personal en lugar de pedir el identificador.
- `POST /api/municipalities/{tenantId}/invitation-addresses/revoke-for-security`, con `email` y `reason`, revoca las invitaciones de administrador y gestor de ese municipio pendientes y dirigidas a esa dirección que nadie ha aceptado. No busca cuentas: devuelve `{ tenantId, email }` con la dirección normalizada, o `404 NOT_FOUND` si no había ninguna pendiente; una dirección mal formada responde `400 INVALID_INPUT`. Registra cada revocación con su motivo. Requiere administrador municipal con MFA reciente.
- `POST /api/municipalities/{tenantId}/administrator-recovery-invitations` recibe `email`, `expiresAt`, `reason` y `verificationReference`. Un operador con MFA reciente invita a un sustituto únicamente si el municipio inicializado no tiene administradores habilitados; en otro caso, por ejemplo cuando el sustituto ya ha aceptado, responde `409 ADMINISTRATOR_RECOVERY_UNAVAILABLE`. La referencia identifica la verificación externa de autoridad; no la realiza automáticamente. No comprueba si existe o está habilitada una cuenta con ese correo; la aceptación lo exige. El correo del propio operador responde `400 INVALID_INPUT` y el operador emisor nunca puede aceptarla. El destinatario acepta con correo verificado y MFA.
- `POST /api/platform/accounts/{accountId}/suspend`, con `reason`, exige operador y MFA reciente. Suspende la cuenta global, revoca sesiones y autoridad propia, incluso la del último operador, e invalida las invitaciones pendientes dirigidas a la cuenta o a su correo verificado, sin cancelar reservas. Un administrador municipal no puede utilizar esta operación por su rol municipal.
- `POST /api/platform/account-suspensions`, con `email` y `reason`, es la misma suspensión identificando la cuenta por su correo exacto, tras recortar espacios y pasar a minúsculas. No hay coincidencias parciales ni listados. Devuelve `{ accountId, suspendedAt }`; un correo desconocido o ambiguo responde `404 NOT_FOUND` con el mismo cuerpo que un identificador desconocido. Exige operador y MFA reciente antes de buscar la dirección.

Una cuenta habilitada está activa, tiene correo verificado y MFA configurado; no necesita mantener una sesión abierta. No se puede deshabilitar MFA conservando permisos administrativos vigentes. Los permisos retirados no se restauran automáticamente.

## Gestores municipales

`POST /api/municipalities/{tenantId}/manager-invitations` recibe `email`, `expiresAt`, `roleExpiresAt` opcional y `permissions: [{ operation, unitId }]`. El administrador invita; el destinatario acepta con MFA mediante `/{invitationId}/accept`. `/{invitationId}/revoke` revoca la invitación o concesión con `{ "reason": "..." }`.

`GET /api/me/manager-invitations` devuelve las invitaciones y concesiones de la cuenta autenticada —incluidas las dirigidas a su correo verificado actual—, con sus permisos y estado. Cada permiso incluye `unitName`, el nombre actual del espacio, que es `null` en los permisos de todo el municipio. Devuelve hasta 20 elementos y `nextCursor`; la página siguiente utiliza `?after=...`. No admite consultas de otra cuenta.

Para sustituir una concesión, la nueva invitación incluye `replacesInvitationId` y `reason`, y no lleva `email`: se dirige al titular actual de la concesión sustituida. Enviar `email` y `replacesInvitationId` a la vez, o ninguno, responde `400 INVALID_INPUT`. La concesión anterior permanece activa hasta la aceptación: esta activa los nuevos permisos y revoca los anteriores en una sola transacción auditada. Las demás concesiones independientes no cambian. Si es necesario retirar acceso inmediatamente, se utiliza la revocación; no se espera a la aceptación de una sustitución.

`GET /api/municipalities/{tenantId}/manager-invitations` permite al administrador con MFA reciente consultar las invitaciones y concesiones del municipio. Incluye destinatario (`recipientEmail` mientras está pendiente; `accountId` y `accountLabel` de la cuenta que la aceptó o a la que se dirigía), emisor, permisos, referencia de sustitución y fechas de vencimiento, aceptación y revocación. Devuelve hasta 20 elementos y `nextCursor`; la página siguiente utiliza `?after=...`. Las fechas describen el historial y no sustituyen la comprobación de autoridad vigente de cada operación.

Cada permiso se limita a una operación y unidad real del municipio; `unitId: null` abarca el municipio. Las operaciones admitidas son `CATALOG_CREATE`, `CATALOG_MANAGE`, `RESERVATION_READ`, `RESERVATION_MANAGE`, `UNIT_BLOCK`, `REPORT_READ`, `DATA_EXPORT`, `PRIVACY_READ` y `PRIVACY_EXECUTE`. `CATALOG_CREATE` y los permisos de privacidad exigen ámbito municipal. Ninguna concede administración de la identidad global ni acceso a otros municipios.

## Catálogo en borrador

`POST /api/municipalities/{tenantId}/facilities` crea una instalación; `POST /api/municipalities/{tenantId}/facilities/{facilityId}/units` crea una unidad. Ambos reciben `{ "name": "..." }`, requieren el permiso municipal `CATALOG_CREATE` y MFA reciente y registran auditoría. Las altas persisten como borradores: no publican recursos ni permiten reservarlos. Estas rutas y `POST /api/municipalities` aceptan `Idempotency-Key`: misma clave y contenido normalizado recuperan el recurso original tras comprobar los permisos actuales; distinto contenido devuelve `IDEMPOTENCY_KEY_REUSED`. Omitir el encabezado representa una solicitud nueva. La interfaz siempre envía una clave y permite recuperar expresamente una respuesta incierta.

`GET /api/municipalities/{tenantId}/facilities/{id}` y `GET /api/municipalities/{tenantId}/units/{id}` consultan un recurso para mantenimiento. `PATCH` sobre esas mismas rutas recibe `{ "name": "..." }` y registra el nombre anterior y el nuevo en la misma transacción. Requieren `CATALOG_MANAGE` y MFA reciente: ámbito municipal para instalaciones, municipal o de la unidad concreta para unidades. No permiten cambiar identificadores ni trasladar unidades entre instalaciones o municipios. Si falla la auditoría, el cambio se revierte.

`PUT /api/municipalities/{tenantId}/facilities/{id}/profile` y `/units/{id}/profile` sustituyen la ficha pública completa: instalaciones con `address`, `postalCode`, `location`, `description`, `accessibility` y `contact`; unidades con `kind`, `indoor`, `capacity` y `description`. Los textos llevan variantes `gl` y `es`; un campo ausente se borra. Exigen `CATALOG_MANAGE` sobre el recurso, MFA reciente y `expectedVersion` igual a `profileVersion` (la lectura administrativa lo devuelve); una versión distinta responde `409 STALE_VERSION`. Cada cambio guarda el estado anterior y el nuevo.

### Fotografías del catálogo

Cada instalación y cada espacio admiten hasta seis fotografías. La primera es la portada. Las rutas cuelgan de `/api/municipalities/{tenantId}/facilities/{id}/photos` y de `/units/{id}/photos`, y exigen el mismo permiso que la ficha: `CATALOG_MANAGE` municipal para las instalaciones y municipal o de la unidad concreta para los espacios, con MFA reciente y `Origin` autorizado. La lectura administrativa del recurso devuelve `photos`, la lista ordenada con `id`, `alt` (`gl` y `es`), `width` y `height`. Cada cambio responde con esa lista completa.

- `POST .../photos` recibe `{ "image": "<base64>", "alt": { "gl": "...", "es": "..." } }`. `image` es un JPEG, PNG o WebP de hasta 6 MiB. El formato se reconoce por su firma antes de decodificarlo, y se rechazan las imágenes animadas, las de más de 36 megapíxeles y las que no son horizontales: la proporción debe ser al menos de 4:3 y, una vez encuadrada a 3:2 desde el centro, de al menos 900 × 600 px. El servidor aplica la orientación y guarda solo su propia versión WebP en dos tamaños: `large`, de hasta 1500 × 1000 px, y `small`, de 600 × 400 px. No conserva el archivo recibido ni sus metadatos (ubicación, cámara o perfil de color). El texto alternativo es obligatorio en los dos idiomas, con 250 caracteres como máximo. Una imagen inservible responde `400 PHOTO_INVALID` y la séptima, `409 PHOTO_LIMIT_REACHED`.
- `PUT .../photos/order` recibe `{ "photoIds": [...] }` con todas las fotografías actuales en el orden nuevo. Si la lista no coincide con las actuales, por ejemplo porque otra persona ha añadido una, responde `409 STALE_VERSION` sin cambios.
- `PATCH .../photos/{photoId}` sustituye `alt`, y `DELETE .../photos/{photoId}` elimina la fotografía y su imagen; las siguientes suben un puesto.
- `GET .../photos/{photoId}/{large|small}` sirve la imagen al editor, también de recursos sin publicar, con `Cache-Control: private, max-age=3600`.

Cada alta, descripción, cambio de orden y eliminación queda registrada con el estado anterior y el nuevo, sin la imagen. La exportación e importación del catálogo no incluye las fotografías. Una imagen nunca cambia: sustituir una foto es eliminarla y añadir otra.

`GET /api/municipalities/{tenantId}/facilities` y `GET /api/municipalities/{tenantId}/units` listan los recursos visibles para la cuenta con MFA reciente. Devuelven hasta 20 elementos y `nextCursor`; la página siguiente utiliza `?after=...`. RLS filtra antes de paginar: un gestor limitado a determinadas unidades no obtiene las restantes ni acceso municipal a instalaciones. Sin recursos autorizados, la respuesta es una lista vacía. Estos listados son administrativos, no publicaciones del catálogo público.

`POST /api/municipalities/{tenantId}/facilities/{id}/withdraw` y la ruta equivalente `/units/{id}/withdraw` reciben `{ "reason": "..." }`. Registran la retirada y su motivo sin eliminar el recurso. Repetir la retirada devuelve el mismo instante sin duplicar el evento. Las consultas administrativas incluyen `withdrawnAt`; `null` indica que no se ha retirado, no que esté publicado. Una instalación retirada conserva sus unidades y no admite nuevas altas. Las reservas comprueban la retirada de la unidad y de su instalación.

## Calendarios de unidades

`PUT /api/municipalities/{tenantId}/units/{unitId}/calendar` recibe `expectedVersion`, `reason` y `calendar`. La primera configuración usa `expectedVersion: 0`; las siguientes deben indicar la versión actual o reciben `409 STALE_VERSION`. Cada versión conserva configuración, autor, motivo e instante; el rol web no puede modificarla ni eliminarla. Requiere `CATALOG_MANAGE` sobre la unidad y MFA reciente.

`calendar` contiene `minimumMinutes`, `maximumMinutes`, `stepMinutes`, `advanceDays`, `weekly` y `exceptions`. Las duraciones son múltiplos positivos del paso. `advanceDays: null` hereda el límite municipal; un valor explícito solo puede reducirlo. Los horarios usan días ISO 1–7 y minutos locales desde medianoche: `{ day, startMinute, endMinute }`. El final puede ser 1440; un intervalo que cruza medianoche se divide entre dos días. Las excepciones `{ date, intervals }` sustituyen el horario semanal de esa fecha; `intervals: []` representa cierre. Las fechas civiles admiten años `0001–9999`. Se rechazan fechas inválidas, duplicados y solapes.

`GET` sobre la misma ruta devuelve la versión actual; `?version=N` recupera una versión histórica. Guardar un calendario no publica la unidad. El guardado rechaza con `409 SCHEDULE_HAS_RESERVATIONS` horarios o excepciones que dejen sin cobertura una reserva confirmada pendiente de finalizar, incluidas las que están en curso; la respuesta no identifica esas reservas. La comprobación y el cambio de versión comparten una transacción SERIALIZABLE. Las reservas conservan sus condiciones aceptadas de duración y antelación; las nuevas reglas no reescriben su historial.

## Publicación del catálogo

`POST /api/municipalities/{tenantId}/facilities/{id}/publish` recibe `{ "reason": "..." }`. Para una unidad, `/units/{id}/publish` exige además `calendarVersion` e `independenceConfirmed: true`. La instalación debe estar publicada y no retirada (`409 FACILITY_NOT_PUBLISHED`); el calendario indicado debe ser el actual (`409 STALE_VERSION`) y superar la validación de reglas. La unidad necesita normas vigentes con contenido; si faltan, devuelve `409 USAGE_RULES_REQUIRED`: «Añade las normas de uso para publicar esta unidad». La confirmación de independencia física queda auditada con el actor y la versión: no es una detección automática de espacios solapados.

Publicar elimina la retirada del recurso indicado, sin borrar historial. Republicar una instalación habilita sus unidades previamente publicadas, no retiradas y con normas válidas. Los cambios no alteran las reservas existentes. Las unidades anteriores publicadas sin normas se ocultan del catálogo y de la disponibilidad hasta completarlas; se conserva `publishedAt`, sin crear normas ni aceptaciones ficticias.

## Normas y política de reserva

`PUT /api/municipalities/{tenantId}/units/{unitId}/usage-rules` recibe `expectedVersion`, `text` y `reason`. Requiere `CATALOG_MANAGE` sobre la unidad y MFA reciente. El texto es plano, no vacío y de hasta 20.000 caracteres. `expectedVersion: 0` crea la primera versión; una versión obsoleta devuelve `409 STALE_VERSION`. Cada versión conserva texto, autor, fecha, motivo y correlación. `GET` devuelve la actual; `?version=N`, una histórica. Los roles de ejecución no pueden sobrescribirlas ni eliminarlas.

`GET` y `PUT /api/municipalities/{tenantId}/booking-policy` requieren administrador municipal y MFA reciente. El cambio recibe `expectedVersion`, `advanceDays`, `cancellationMinutes` y `reason`; incrementa la versión y conserva auditoría. Una versión obsoleta devuelve `409 STALE_VERSION`. No puede reducir la antelación municipal por debajo de un límite explícito vigente de una unidad (`409 UNIT_ADVANCE_EXCEEDS_LIMIT`). Los municipios nuevos parten de 30 días de antelación y 1.440 minutos de cancelación; las actualizaciones conservan las configuraciones existentes. Cambiar la política no modifica el plazo ya aceptado de las reservas.

## Tiempo civil y zonas IANA

La conversión usa `@js-temporal/polyfill` 0.5.1: Node 24.21.0 no expone Temporal en el entorno verificado. La dependencia evita mantener reglas de conversión horaria propias. Los modos `earlier` y `later`, comprobados mediante conversión de vuelta a hora local, permiten descartar horas inexistentes y conservar ambas ocurrencias de una hora repetida. Cada instante conserva UTC, fecha/hora local, desplazamiento y zona. La antelación compara fechas locales, no bloques de 24 horas. [Modelo temporal y ambigüedad](https://tc39.es/proposal-temporal/docs/timezone.html), [polyfill](https://github.com/js-temporal/temporal-polyfill).

Las pruebas incluyen Madrid, transiciones de media hora en Lord Howe y una fecha completa omitida en Apia. Los intervalos de apertura se intersectan con cada tramo de desplazamiento constante del día. Así, dos aperturas de una hora repetida permanecen separadas si existe un cierre real entre ellas; una jornada completa puede representar 23 o 25 horas reales. La generación de franjas aplica duración real, paso y antelación: los inicios se alinean con el comienzo de cada apertura civil continua y la duración se mide entre instantes UTC. Cada reserva candidata debe quedar íntegramente cubierta por apertura, incluso al cruzar medianoche. Una excepción del día siguiente puede impedir ese cruce. La API pública descarta las franjas que solapan ocupaciones no liberadas de reservas o bloqueos. La revisión completa de licencias y atribuciones sigue pendiente; el polyfill declara ISC y su dependencia JSBI, Apache-2.0.

## Catálogo y disponibilidad públicos

Sin sesión, bajo `/api/public/municipalities/{tenantId}`:

- `GET /booking-durations`: duraciones admitidas por alguna unidad publicada, con `recommended`, la que admiten más unidades; en caso de empate, la más corta.
- `GET /availability-search?date=AAAA-MM-DD&durationMinutes=N`: unidades con franjas libres, recorridas por páginas; `facilityId` limita la búsqueda a una instalación. Una página vacía con `nextCursor` no indica que se haya agotado el catálogo.
- `GET /facilities`: instalaciones publicadas con `units`, el número de unidades que se pueden reservar, su `profile` y sus `photos`, hasta 20 por página; `?after=nextCursor` continúa el listado.
- `GET /facilities/{facilityId}/units`: unidades publicadas de una instalación publicada y no retirada, con `minimumMinutes` y `maximumMinutes` de su calendario vigente, sus `photos` y la misma paginación.
- `GET /units/{unitId}`: nombre, instalación, `profile` del espacio y `facilityProfile`, `photos` del espacio y `facilityPhotos` de su instalación, zona, límites, calendario, `usageRulesVersion` y `bookingPolicyVersion`, sin datos de auditoría.
- `GET /photos/{photoId}/{large|small}`: imagen WebP de una fotografía de un recurso publicado, con `ETag` y `Cache-Control: public, max-age=3600`. Una fotografía eliminada o de un recurso retirado o sin publicar responde `404`, también al revalidar. Tiene su propio límite de 60 imágenes por minuto y dirección, de modo que una galería no agota el de las búsquedas.
- `GET /units/{unitId}/usage-rules`: texto plano y versión de las normas vigentes, sin autor ni motivo internos.
- `GET /units/{unitId}/availability?date=AAAA-MM-DD&durationMinutes=N`: franjas libres con UTC, hora local, desplazamientos, versión y momento de cálculo.
- `GET /units/{unitId}/next-availability?from=AAAA-MM-DD&durationMinutes=N`: las tres primeras franjas libres de esa duración desde `from`, dentro de la antelación permitida y como máximo 62 días. Comprueba todos los días candidatos contra las ocupaciones en una sola consulta. La ficha del espacio las sugiere cuando el día elegido no tiene huecos y enlaza directamente a reservarlas.

Estas consultas no crean cuentas ni perfiles. Los recursos no publicados o retirados no aparecen. Las unidades sin normas válidas tampoco se ofrecen; su detalle responde `404`. La disponibilidad lee calendario y ocupaciones en una misma transacción y descarta cualquier solape con una ocupación no liberada. Solo expone franjas, no titulares, identificadores de reservas ni motivos de bloqueos. Consultar no garantiza ni confirma una reserva. Las rutas públicas comparten un límite de 60 peticiones por 60 segundos y dirección reconocida por Fastify, incluso entre réplicas. Al superarlo devuelven `429 RATE_LIMITED` y `Retry-After`, antes de validar parámetros o calcular franjas. No confían en cabeceras de proxy enviadas por el cliente. PostgreSQL conserva una huella HMAC con clave compartida, no la IP en claro; cada petición elimina hasta 100 contadores cuya ventana tiene más de diez minutos. Sin tráfico, la limpieza se reanuda en la próxima petición; no constituye una garantía de borrado exactamente a los diez minutos. Las réplicas deben compartir `AUTH_SECRET`; rotarlo también reinicia la identidad de estos contadores.

## Informes de la política de contenido

`POST /api/csp-reports` recibe los informes que el navegador envía al infringirse la política de seguridad de contenido de la aplicación web. Admite `application/reports+json` (Reporting API: lista de 1 a 100 informes de tipo `csp-violation` con `body.documentURL` y `body.effectiveDirective`) y `application/csp-report` (formato heredado de `report-uri`: objeto `csp-report` con `document-uri` y `effective-directive` o `violated-directive`). No exige sesión, `Origin` ni `Idempotency-Key` y responde `204` sin cuerpo. Otros tipos de contenido devuelven `415 UNSUPPORTED_MEDIA_TYPE`; un JSON inválido o que no cumple el esquema, `400 INVALID_INPUT`, y un cuerpo de más de 16 KiB, `413 PAYLOAD_TOO_LARGE`; ninguna respuesta repite el contenido recibido. Tiene su propio límite de 60 peticiones por minuto y dirección, con la misma huella HMAC que las rutas públicas pero separado de ellas, de modo que una página con infracciones repetidas no agota el catálogo público; al superarlo responde `429 RATE_LIMITED` con `Retry-After`. Los campos adicionales se aceptan y se descartan sin leerlos. Solo se registra un evento por informe sobre una página del propio origen, con los campos descritos en [operación](12_operacion.md#infracciones-de-la-política-de-contenido).

## Textos legales

`GET /api/public/notices/{kind}` y `GET /api/public/municipalities/{tenantId}/notices/{kind}` devuelven el último texto publicado de la instancia o del municipio (`kind`: `privacy`, `legal` o `accessibility`). Con `version` 0 y `body` vacío todavía no hay texto. `PUT /api/municipalities/{tenantId}/notices/{kind}` (administrador) y `PUT /api/platform/notices/{kind}` (operador) publican una versión nueva con `{ "expectedVersion": N, "body": { "gl": {…}, "es": {…} } }`; exigen MFA reciente y una versión distinta devuelve `409 STALE_VERSION`. Los campos admitidos por tipo están en la descripción OpenAPI. Las versiones se guardan sin posibilidad de modificarlas ni borrarlas.

## Portabilidad y calendario personal

`GET /api/municipalities/{tenantId}/exports/catalog` (administrador, MFA reciente) devuelve el JSON `quenda.catalog` v1: ajustes del municipio, instalaciones y espacios con su ficha, calendario y normas vigentes y estado de publicación. No contiene reservas ni datos personales; su esquema y su ejemplo están en la respuesta OpenAPI. Sirve para archivo y para trasladar el catálogo.

`POST /api/municipalities/{tenantId}/imports/catalog` carga ese documento (validado con el mismo esquema) en un municipio que todavía no tiene instalaciones, de esta u otra instancia. Exige administración del municipio, MFA reciente y `Origin` autorizado, y admite `Idempotency-Key`. En una transacción crea instalaciones y espacios en borrador con identificadores nuevos, sus fichas (versión 2, auditada como una primera edición), calendario y normas en su versión 1. Responde con los recuentos y los recursos retirados que omitió. Con `?settings=include` aplica además la política de reserva (antelación y plazo de cancelación) y la apariencia (tema del catálogo, ajustes de color por modo, tipografía, esquinas y modo inicial) del documento; acepta también el formato anterior de dos paletas, antes de validar los calendarios contra la nueva antelación. Usa las mismas funciones auditadas que una edición manual, con motivo `Importado de quenda.catalog`, y deja intactos los valores que ya coinciden; la respuesta indica en `settings` qué se aplicó. Sin la opción, los ajustes del documento se ignoran. No importa el estado de publicación, el nombre ni la zona horaria, reservas ni cuentas: cada municipio revisa y publica su catálogo. Con instalaciones ya creadas responde `409 CATALOG_NOT_EMPTY`; un documento mal formado responde `400` sin cambios. En la web, «Importar un catálogo» aparece en «Instalaciones y unidades» mientras el municipio está vacío, con una casilla para aplicar también la política de reserva y la apariencia del archivo. Para trasladar una instancia completa, con reservas y cuentas, se usan la copia lógica y la restauración.

`GET /api/municipalities/{tenantId}/exports/reservations` admite `format=csv`: una fila por reserva (columnas en `reservationCsvColumns`), RFC 4180, UTF-8 con marca de orden de bytes y las celdas que empiezan por `=`, `+`, `-`, `@` o tabulación precedidas de `'`. Los textos largos de normas quedan solo en el JSON.

`GET /api/municipalities/{tenantId}/reservations/{reservationId}/calendar.ics` y `GET /api/me/reservations/calendar.ics` devuelven archivos iCalendar (RFC 5545) de una reserva del titular, en cualquier estado, o de sus próximas reservas confirmadas (hasta 100). Las horas van en UTC; el `UID` es estable, `SEQUENCE` es la revisión y una cancelación lleva `STATUS:CANCELLED`, de modo que volver a importar actualiza el evento. `lang=es|gl` fija el idioma del texto; sin él se usa `Accept-Language`. Son descargas puntuales.

Para que el calendario se actualice solo, el titular crea una suscripción desde «Mis reservas» › «Añadir a mi calendario» (`POST /api/me/calendar-subscription`, con `Origin` autorizado). La respuesta trae, una única vez, `url` y `webcalUrl`: `GET /api/calendars/{secreto}.ics` devuelve sin sesión las próximas reservas confirmadas de la cuenta (hasta 100), con la misma identidad y revisión que las descargas; una reserva cancelada o finalizada desaparece del calendario. El secreto son 32 bytes aleatorios y la base guarda solo su SHA-256, así que una copia de la base no permite reconstruir la URL. Crear de nuevo sustituye el secreto; `POST /api/me/calendar-subscription/revoke` lo retira, y la baja, la suspensión o la supresión de la cuenta también, sin que una reactivación lo recupere. Una URL desconocida o retirada responde `404`. El límite es de 60 peticiones por minuto por URL, porque las aplicaciones de calendario consultan desde direcciones compartidas; las URL desconocidas cuentan además contra la dirección de origen. La imagen web no registra en su log estas rutas. Quien tenga la URL ve esas reservas: la interfaz lo advierte y no vuelve a mostrarla.

## Recomendaciones de horario

`GET /api/me/recommendations` devuelve hasta tres franjas que repiten un hábito del titular: el mismo espacio, día de la semana, hora local de inicio y duración, reservado y confirmado al menos dos veces en los últimos 183 días (`domain.own_booking_habits`, que solo lee las reservas de la cuenta de la sesión). Para cada hábito busca la primera fecha libre de ese día de la semana y hora en los próximos 62 días, dentro de la antelación permitida, con el mismo cálculo y las mismas ocupaciones que la disponibilidad pública; no reserva ni garantiza la franja. Los espacios que ya no están publicados o que ya no admiten esa duración se omiten. Cada respuesta se calcula en el momento: no se guarda ningún perfil, no interviene ningún modelo de inteligencia artificial y nadie más que el titular ve el resultado.

`PUT /api/me/recommendations` con `{ "enabled": false }` (sesión y `Origin` autorizado) las desactiva; entonces la lectura responde `enabled: false` sin consultar las reservas. La preferencia es el único dato nuevo, figura en la descarga de datos personales y se suprime con la cuenta. En la web aparecen en «Mis reservas» bajo «Tus horarios habituales», con enlace directo a la confirmación de cada franja, y se activan o desactivan en «Privacidad y baja de cuenta».

## Consulta de reservas

- `GET /api/municipalities/{tenantId}/reservations/{reservationId}`: estado actual de una reserva. Admite al titular sin MFA y al personal con permisos vigentes sobre la unidad y MFA. Un identificador de otro municipio o fuera del ámbito autorizado no revela la reserva. Incluye los nombres actuales del municipio, la instalación y el espacio (`municipalityName`, `facilityName`, `unitName`), leídos con la misma autorización que la reserva (`domain.reservation_place`) y no con el catálogo público: se mantienen aunque el espacio o la instalación se hayan retirado y no consumen el límite de peticiones públicas. Solo serían `null` si el espacio no existiera.
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

## Acceso con código QR

El detalle de una reserva confirmada ofrece al titular «Ver código de acceso», que abre un diálogo con el código QR a tamaño de lectura junto al espacio, el lugar, la fecha, el horario y la referencia que el personal coteja. El código contiene la dirección de la reserva en la gestión municipal (`/administracion/{tenantId}/reservas/{reservationId}`), así que el personal lo escanea con la cámara de su teléfono, donde ya ha iniciado sesión, y ve si la reserva es válida en ese momento. No hace falta ningún lector ni acceso a la cámara desde la aplicación. El código no es un secreto: la página solo muestra la reserva a quien tiene permiso sobre su unidad.

`POST /api/municipalities/{tenantId}/reservations/{reservationId}/arrival` registra la llegada. Exige `RESERVATION_READ` o `RESERVATION_MANAGE` sobre la unidad, sesión con MFA y `Origin` autorizado, y solo se admite en reservas confirmadas desde 30 minutos antes del inicio hasta el final (`409 ARRIVAL_OUTSIDE_WINDOW` fuera de esa ventana). La llegada queda en la propia reserva con instante y autor; repetir la petición devuelve el primer registro con `alreadyRecorded: true`. No cambia la revisión ni genera avisos. El rol de la aplicación no puede escribir esas columnas directamente. El titular ve la hora de llegada en su reserva y en la descarga de datos personales. La conservación la archiva o suprime junto con la reserva. Quenda no abre puertas ni tornos: el registro sirve para el control del personal y para los indicadores.

## Bloqueos de unidades

`GET /api/municipalities/{tenantId}/agenda/units` devuelve identificador y nombre de las unidades con `RESERVATION_READ`, `RESERVATION_MANAGE` o `UNIT_BLOCK`, incluidas las retiradas. Exige MFA y no concede permisos de catálogo. Devuelve páginas de 20 y `nextCursor`; `after` continúa la consulta.

`GET /api/municipalities/{tenantId}/blocks` devuelve los bloqueos autorizados por `UNIT_BLOCK`, incluidos los liberados, con MFA reciente. Admite `date`, `unitId` y `after`; el filtro de día utiliza la zona municipal antes de paginar. No expone motivos de bloqueos ajenos.

`POST /api/municipalities/{tenantId}/blocks` recibe `unitId`, `startsAt`, `endsAt` y `reason`. Exige `UNIT_BLOCK` sobre la unidad, MFA reciente, origen autorizado e `Idempotency-Key`; devuelve `201`. Los intervalos deben ser finitos y ordenados, sin aplicar al mantenimiento las reglas de duración o antelación de una reserva. Un solape con una reserva o bloqueo no liberado produce `409` sin cambios parciales. Las reservas afectadas deben resolverse mediante operaciones explícitas.

`POST /api/municipalities/{tenantId}/blocks/{blockId}/release` recibe un nuevo `reason` y devuelve `200`. Libera la ocupación y conserva el bloqueo y su motivo original; registra el motivo de retirada en un evento inmutable. Repetir la retirada no genera otro evento. Ambas operaciones son idempotentes y comprueban permisos antes de recuperar resultados. La disponibilidad pública refleja sus efectos tras el commit.

## Integridad de reservas y bloqueos

PostgreSQL mantiene una ocupación activa por reserva confirmada o bloqueo vigente. Una exclusión temporal compartida impide solapes en la misma unidad y municipio; los intervalos son semiabiertos `[inicio, fin)`, por lo que admiten reservas consecutivas. Las claves compuestas impiden referencias entre municipios.

Las restricciones diferidas comprueban al confirmar la transacción que la unidad y el intervalo de la ocupación coinciden con su origen. Cancelar una reserva o liberar un bloqueo exige liberar su ocupación en la misma transacción. Cambiar una reserva sustituye la ocupación sin borrar la anterior; un conflicto revierte todos los cambios. Los permisos SQL y RLS restringen la lectura y modificación al contexto autorizado.

La confirmación HTTP utiliza estas garantías. Los cambios de calendario incompatibles requieren resolver antes las reservas afectadas mediante operaciones explícitas.

## Colaboración entre municipios

### Convenios: creación, versiones y aprobación

Los comandos requieren administrador del municipio participante, sesión verificada, MFA reciente, `Origin` autorizado e `Idempotency-Key`. Comprueban los permisos actuales antes de recuperar un resultado idempotente.

- `POST /api/municipalities/{tenantId}/agreements`: registra nombre, zona IANA, vigencia, finalidad, base jurídica, responsabilidades, conservación, elegibilidad, cuota opcional, capacidad de informes y participantes con sus unidades y condición de emisor. Devuelve `201` con `agreementId`, `version: 1` y `BORRADOR`.
- `POST /api/municipalities/{tenantId}/agreements/{agreementId}/versions`: recibe la configuración completa y `expectedVersion`, sin nombre ni zona. Devuelve `201` con la nueva versión `BORRADOR`; una versión base obsoleta produce `409 STALE_VERSION`. Conserva las evidencias anteriores sin trasladar sus aprobaciones.
- `POST /api/municipalities/{tenantId}/agreements/{agreementId}/approve`: recibe `version` y el conjunto exacto `unitIds` del municipio. Devuelve `200`: `BORRADOR` mientras falten participantes y `APROBADO` cuando todos hayan aprobado. No admite nuevas aprobaciones de versiones superadas.

Las respuestas incluyen las cabeceras de idempotencia y `Cache-Control: no-store`. Un replay conserva el resultado original, no representa necesariamente el estado actual. Ninguno de estos comandos activa el convenio ni habilita capacidades de reserva.

- `GET /api/municipalities/{tenantId}/agreements`: lista las versiones visibles al administrador municipal con MFA reciente, en páginas de 20 y orden por convenio/versión. `after` acepta el `nextCursor` anterior; no identifica versiones efectivas.
- `GET /api/municipalities/{tenantId}/agreements/{agreementId}/versions/{version}`: devuelve configuración, participantes, unidades, aprobaciones y evidencia de creación. Una versión sin participación del municipio devuelve `404`, aunque haya participado en otra versión. Ambas consultas utilizan `Cache-Control: no-store`.

### Acreditaciones

- `POST /api/municipalities/{tenantId}/credentials`: recibe `agreementId`, `version`, `accountId`, `startsAt`, `endsAt` y `verificationReference`. Exige administrador con MFA reciente, municipio emisor habilitado, cuenta vinculada a ese municipio y versión activa dentro de su vigencia efectiva en modo `acreditacion_vigente`. Devuelve `201` con el identificador y `revoked: false`; no afirma elegibilidad para una reserva.
- `POST /api/municipalities/{tenantId}/credentials/{credentialId}/revoke`: recibe `reason`; exige administrador del municipio emisor con MFA reciente y devuelve `200` con `revoked: true`. Permite revocar aunque el convenio esté suspendido y conserva el primer motivo y la evidencia de emisión.

Ambos comandos requieren `Origin` autorizado e `Idempotency-Key`, devuelven cabeceras de idempotencia y `Cache-Control: no-store`, y revalidan permisos antes del replay. El listado solo muestra acreditaciones emitidas por el propio municipio; no existe un listado general ni una consulta libre de elegibilidad.

Las reservas de unidades adscritas comprueban, en su misma transacción, la vigencia efectiva del convenio, la acreditación que cubre todo el intervalo cuando se exige y la cuota semanal conjunta por cuenta. Crear atribuye el consumo; reprogramar recalcula semana y destino; cancelar lo libera. Una modificación sin cambios conserva la atribución. El rechazo revierte reserva, ocupación, consumo, auditoría y resultado idempotente; no devuelve consumos ni acreditaciones ajenas. La suspensión permite cancelar, pero impide nuevas reservas y reprogramaciones; cerrar la adscripción no activa el acceso público automáticamente.

`POST /api/municipalities/{tenantId}/agreements/{agreementId}/suspend` recibe `version` y `reason`. Un administrador participante con MFA reciente suspende el convenio completo y cierra sus vigencias efectivas, incluidas las programadas. El municipio debe participar en una versión en vigor o programada: quien solo participó en una versión ya sustituida o vencida recibe `409 AGREEMENT_STATE_CONFLICT`. Conserva reservas, consumos y vinculaciones de unidades; registra actor, municipio, motivo y correlación. Devuelve `200` con `SUSPENDIDO`; repetir no duplica eventos. Exige `Origin` autorizado e `Idempotency-Key`. Un borrador o una versión únicamente aprobada no puede suspenderse mediante este comando.

`POST /api/municipalities/{tenantId}/agreements/{agreementId}/activate` activa una nueva versión aprobada, incluida la sustitución o reactivación. Recibe `version`, `legalReviewReference` y `reportReviewReference` (puede ser nula si no se habilitan informes). Exige la versión aprobada más reciente, aprobación de todos los participantes, unidades adscritas y emisor habilitado si se requieren acreditaciones. Concilia las reservas confirmadas de las unidades y vigencia aprobadas, conservándolas aunque superen la cuota o no cumplan la nueva elegibilidad. Devuelve `200` con `ACTIVADO`. La operación completa es idempotente y atómica; exige administrador participante, MFA reciente y `Origin` autorizado. Otra activación de la misma versión con una clave nueva devuelve `409 AGREEMENT_STATE_CONFLICT`. Sustituir o reactivar exige una nueva versión y todas sus aprobaciones; cierra las vigencias anteriores sin solapes, conserva sus evidencias y no reinicia los consumos de cuota, tampoco al retirar unidades.

### Reapertura municipal de unidades

- `GET /api/municipalities/{tenantId}/units/{unitId}/agreement-restriction`: devuelve la vinculación persistente o `null`, con `agreementId`, `agreementName` y `version`. `agreementName` es `null` solo si el convenio no es visible para el municipio. `hasRemainingAssignment` indica si existen adscripciones actuales o programadas; no representa disponibilidad para reservar.
- `POST /api/municipalities/{tenantId}/units/{unitId}/agreement-restriction/release`: recibe `expectedAgreementId`, `expectedVersion` y `reason`. Retira la restricción únicamente si coincide la vinculación esperada y no quedan adscripciones actuales ni programadas. Conserva publicación, calendario, reservas y consumos; registra actor, motivo y correlación. Devuelve `removed: false` si ya no existe restricción.

Ambos endpoints exigen administrador municipal y MFA reciente. El comando exige `Origin` autorizado e `Idempotency-Key`; revalida permisos antes del replay. Retirar la restricción no publica la unidad ni libera ocupaciones.

## Comunicaciones

### Avisos internos

`GET /api/me/notices` devuelve los avisos del usuario autenticado entre municipios, del más reciente al más antiguo, con `Cache-Control: no-store`. Pagina de 20 en 20; `after` acepta el `nextCursor` anterior. Cada aviso contiene tipo, revisión, fecha del evento e intervalo histórico, el municipio y los nombres actuales del espacio y de la instalación (`null` si ya no existen), `readAt` (la fecha en que su titular lo leyó, o `null` si sigue sin leer) y `reservationPath` para consultar el estado actual. La reubicación administrativa indica si exige aceptar normas antes del uso. En intervenciones administrativas incluye el nombre capturado del autor y el motivo, además de la fecha del evento; los registros antiguos sin nombre capturado no se completan con el nombre actual. No expone identificadores del actor ni correlaciones, y no representa el estado de entrega del correo.

`GET /api/me/notices/unread` devuelve `{ "unread": N }`, el número de avisos sin leer, para el contador del menú. Igual que `GET /api/me`, solo lee el estado de la propia cuenta y no consume el límite de peticiones administrativas. `POST /api/me/notices/{tenantId}/{eventId}/read` marca un aviso como leído y `POST /api/me/notices/read` marca todos; ambos devuelven `{ "read": N }` con el número de avisos que han cambiado y conservan la primera fecha de lectura. Un aviso ajeno o ya leído devuelve `{ "read": 0 }`, sin distinguir ambos casos. Los avisos creados antes de esta función figuran como leídos.

### Idioma de avisos

`GET /api/me/preferences` consulta la preferencia de la cuenta autenticada. `PUT /api/me/preferences`, con `Origin` autorizado, recibe únicamente `{ "locale": "gl" }`, `{ "locale": "es" }` o `{ "locale": null }`. El valor nulo utiliza `EMAIL_LOCALE` del worker. No permite consultar ni modificar otra cuenta.

Cada correo guarda la preferencia del titular al generarse el evento, también cuando la operación la realiza personal municipal. Cambiar la preferencia no altera correos ya pendientes. El worker utiliza ese idioma guardado y solo recurre a su configuración cuando no existe una elección del titular.

## Indicadores, análisis y exportación

### Indicadores municipales y por unidad

`GET /api/municipalities/{tenantId}/units/{unitId}/indicators?from=2030-01-01&to=2030-02-01` exige `REPORT_READ` sobre la unidad y MFA. El periodo usa fechas locales `[from,to)`, con un máximo de 366 días. Devuelve conteos por estado, minutos reservados, minutos ofertados y porcentaje de ocupación (`null` cuando la oferta es cero), con zona e instante de consulta.

`GET /api/municipalities/{tenantId}/indicators` acepta el mismo periodo y exige `REPORT_READ` municipal y MFA. Incluye todas las unidades, aunque estén retiradas, en una misma transacción y con un único instante de consulta. Suma minutos antes de calcular el porcentaje; no promedia porcentajes por unidad. Un municipio sin unidades devuelve conteos y minutos cero, y porcentaje `null`. Los permisos limitados a unidades no habilitan este total municipal.

La oferta utiliza versiones de calendario y eventos históricos de publicación/retirada de instalación y unidad. Los cierres se recortan a su vigencia efectiva. Dos transiciones contradictorias de publicación con el mismo instante devuelven `409` en vez de inventar un orden. No se devuelven titulares, motivos ni eventos de auditoría. Las respuestas usan `Cache-Control: no-store`.

### Análisis de uso

`GET /api/municipalities/{tenantId}/analytics?from=…&to=…` (opcionalmente `unitId` y `granularity`) completa los indicadores con el mismo permiso (`REPORT_READ` municipal o de la unidad, con MFA), periodo y límite de 366 días. Devuelve:

- `summary`: los indicadores básicos del mismo ámbito y periodo, calculados con las mismas fórmulas.
- `series`: minutos ofertados y reservados, porcentaje, reservas y cancelaciones por tramo. `granularity` admite `day`, `week` (semana ISO, desde el lunes) y `month`. Por defecto usa días hasta 31 días, semanas hasta 183 y meses a partir de ahí. El primer y el último tramo se recortan al periodo; los tramos suman lo mismo que `summary`.
- `weekdayHours`: minutos ofertados y reservados, y su porcentaje, por día ISO (1 = lunes) y hora local.
- `units`: los mismos minutos por unidad, con su nombre e instalación, sus reservas y cancelaciones, y su ocupación por tramo de `series` (`trend`). Suman lo mismo que los indicadores básicos.
- `cancellations`: canceladas por el titular y por el ayuntamiento, según el autor del evento de cancelación.
- `leadTime`: reservas por tramos de antelación (de la creación al inicio).
- `attendance`: llegadas registradas con el código QR sobre las reservas confirmadas ya finalizadas. Mide lo que registra el personal, no la asistencia real.

Cancelaciones, antelación y llegadas cuentan las reservas que empiezan en el periodo, como los indicadores. Solo devuelve agregados, sin titulares. Rechaza más de 20.000 reservas. En la web, «Uso de los espacios» pide el análisis del periodo elegido y el del periodo anterior de la misma duración (los meses anteriores si el periodo son meses completos), y no consulta por separado los indicadores básicos. La antigua dirección `/indicadores` lleva a esa pantalla.

`GET /api/municipalities/{tenantId}/analytics/units` devuelve las unidades que la cuenta puede analizar (`REPORT_READ` municipal o de la unidad), con su instalación y si están retiradas. Exige MFA, incluye las retiradas y las ordena por instalación y nombre. Devuelve hasta 500 y `truncated` indica que hay más. Solo identifica unidades; no concede otros accesos. El mapa por día y hora es una tabla con el porcentaje escrito en cada celda; el tono solo lo refuerza.

### Ajustes de analítica

`GET /api/municipalities/{tenantId}/analytics/settings` devuelve los ajustes del municipio con `version`:

- `highDemandPercent`: una ocupación igual o superior marca un espacio como de alta demanda. Por defecto, 85.
- `lowUsePercent`: una ocupación inferior lo marca como de poco uso. Por defecto, 20.
- `defaultPeriod`: periodo con el que se abre el análisis: `THIS_WEEK`, `THIS_MONTH` (por defecto), `LAST_MONTH` o `LAST_30_DAYS`.

La lectura exige MFA y `REPORT_READ` municipal o de alguna unidad. Los ajustes no cambian ningún cálculo: solo etiquetan resultados y eligen el periodo inicial.

`PUT` sobre la misma ruta los sustituye con `expectedVersion`. Exige administración del municipio y MFA reciente. Los umbrales son enteros entre 1 y 99, y «poco uso» debe ser menor que «alta demanda». Una versión obsoleta responde `409 STALE_VERSION`. Cada cambio registra autor, versión, valores anteriores y nuevos en una misma transacción. Afecta a todas las personas que analizan el municipio. Las preferencias de presentación de cada persona (tipo de gráfico, bloques visibles) se guardan en su navegador y no pasan por la API. La exportación del catálogo no incluye estos ajustes.

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

### Revisión y entrega de informes mensuales

`GET /api/municipalities/{tenantId}/report-agreements` lista los convenios cuyo informe puede solicitar el municipio. Exige `REPORT_READ` municipal y MFA; un permiso limitado a unidades no basta. Incluye cada convenio con una versión `ACTIVADO` con informes agregados en la que participa el municipio y devuelve solo `agreementId`, `name` y `version`, la última de esas versiones. No incluye otros participantes, unidades, meses, métricas ni revisiones. Páginas de 20 ordenadas por convenio; `after` recibe el último `agreementId`. Usa `Cache-Control: no-store`. Figurar en la lista no garantiza que un mes sea publicable.

Base: `/api/municipalities/{tenantId}/agreements/{agreementId}/reports/{AAAA-MM}`.

- `GET /review-context?revision=1&recipientTenantId=…&recipientAccountId=…`: devuelve referencias y `historyDigest`, sin métricas ni historial individual. Exige administrador participante y MFA reciente.
- `POST /reviews`: registra `revision`, destinatario, `expectedHistoryDigest`, decisión `APPROVE`/`REJECT` y referencias `auxiliaryReference`, `ownDataReference`, `priorReleasesReference` y `correctionReference`. Esta última puede ser `null` solo en la primera revisión. Exige administrador, MFA reciente, Origin e `Idempotency-Key`. Si el historial de entregas o la evaluación cambiaron después de leer el contexto, responde `409 STALE_VERSION`.
- `GET` sobre la base: entrega el último informe autorizado al usuario autenticado, con `REPORT_READ` municipal y MFA. No admite filtros ni selección de revisiones. Registra la entrega en la misma transacción; si falla ese registro, no devuelve el informe.

Todas las respuestas usan `Cache-Control: no-store`. La entrega necesita capacidad vigente y revisiones favorables de todos los municipios participantes, vinculadas al destinatario, evaluación e información previamente entregada. Un nuevo rechazo impide entregas posteriores. Sin autorización de publicación, devuelve únicamente `{"status":"NOT_PUBLISHABLE"}`, sin métricas, ceros ni causas. Las referencias de revisión documentan la evaluación humana del riesgo; no certifican automáticamente anonimato.

## Privacidad y conservación

Los permisos `PRIVACY_READ` y `PRIVACY_EXECUTE` son explícitos, requieren MFA reciente y no se heredan del rol de administrador u operador. Para un municipio se conceden mediante las invitaciones de gestores, con `unitId: null`. La concesión global utiliza `/api/platform/privacy-invitations` con `email`, `permissions`, `reason`, `expiresAt` y `roleExpiresAt` opcional, y requiere aceptación de la cuenta con ese correo verificado; solo cubre identidad y evidencias globales, no actividad municipal. Su listado para operadores (`GET`) incluye `recipientEmail` mientras la invitación no se ha aceptado y `accountId` de la cuenta que la aceptó. Una baja o suspensión retira las concesiones y no las recupera automáticamente.

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

`POST /api/municipalities/{tenantId}/shared-retention/context` recibe `ownerTenantId`, `category` (`RESERVATIONS` o `ACCREDITATIONS`), `targetKey`, `action` y `blockDays` solo para `BLOCK`. Requiere `PRIVACY_READ` municipal y MFA reciente; devuelve la huella y los responsables históricos con su estado de aprobación, sin contenido personal. `POST /shared-retention/review` en la misma base añade `digest`, `approved`, `authorizationReference` y `reason`; exige además `PRIVACY_EXECUTE`. Solo registra la decisión del municipio autenticado; una huella que ya no coincide con el contexto actual responde `409 STALE_VERSION`.

Las aprobaciones vinculan registro, evidencias, política vigente, actuación y plazo; cualquier cambio requiere revisarlas. La ejecución individual o por política comprueba unanimidad, dependencias y excepciones de todos los responsables. Los archivos bloqueados conservan ese ámbito para respetar excepciones posteriores. El checkpoint incluye la prueba de revisión para reproducir la actuación durante una restauración cerrada. Véase el [modelo de conservación](02_modelo_dominio.md#ejecución-y-excepciones).

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
| `AUTHORITY` | Permisos e invitaciones retirados o vencidos, y evidencias asociadas; último hecho del conjunto. Los accesos de privacidad y rechazos globales se tratan por evento independiente. El correo de una invitación no aceptada se trata por separado, desde su revocación o vencimiento: `address:administrator:{id}` o `address:manager:{id}` en el municipio y `address:operator:{id}` o `address:privacy:{id}` en el ámbito global. Se archiva y se retira de la invitación, que conserva su historial. El conjunto global de una cuenta incluye los eventos de las invitaciones de operador que aceptó, aunque el evento de invitación no la nombrara. |
| `ACCREDITATIONS` | Acreditación vencida o revocada; revocación, si existe, o fin de vigencia en otro caso. Las evidencias compartidas requieren revisión de los responsables. |
| `AUTHENTICATION` | Eventos de seguridad cerrados y artefactos técnicos vencidos; hecho registrado o vencimiento. No elimina credenciales activas por antigüedad. |
| `IDENTITY` | Cuenta dada de baja; instante de baja, sin autoridad, conflictos de seguridad ni evidencia municipal dependiente. Retira acceso y datos directos; los identificadores residuales no se consideran anónimos. |

El worker existente revisa la conservación cada minuto en lotes acotados. La selección de registros ordinarios requiere una política aprobada. Los archivos bloqueados siguen su autorización y fecha de destrucción, aunque procedan de una actuación individual o la política original ya no esté activa. Cada actuación respeta las excepciones, vuelve a comprobar el estado y confirma cambios y auditoría en una transacción. Los conflictos se registran sin eliminar el conjunto afectado; se reevalúan con espera para que no impidan avanzar a otros registros. Cada municipio puede tener periodos distintos en la misma instancia.

`BLOCK` retira el registro de las consultas ordinarias y guarda el contenido necesario en `retention_archive`, inaccesible a los roles de ejecución. No copia secretos de autenticación. La destrucción posterior utiliza la fecha aprobada y respeta excepciones vigentes. `domain.read_blocked_privacy_record` solo está disponible en mantenimiento y exige referencia de autorización, finalidad legal y correlación; registra el acceso. El responsable debe verificar que la consulta excepcional esté legalmente permitida.

Una excepción identifica `category` y exactamente uno de `targetKey` o `subjectId`, junto con `authorizationReference` y `reason`. Impide la eliminación correspondiente; no bloquea por sí sola el uso ordinario de los datos. La actuación individual recibe categoría, registro, acción, referencia de autorización y motivo, más `blockDays` cuando corresponda. Su respuesta diferencia `APPLIED`, `CONFLICT` y `ABSENT`: HTTP 200 confirma una evaluación auditada, no necesariamente una eliminación. No sustituye la tramitación administrativa de una solicitud de derechos.
