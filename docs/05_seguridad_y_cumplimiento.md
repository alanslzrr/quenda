# 05 Seguridad y cumplimiento

## Identidad y acceso

Better Auth gestiona cuentas y sesiones. Cada cuenta identifica a un usuario del sistema; verificar el correo acredita acceso al buzón, no identidad civil ni residencia. Las acreditaciones de uso se conceden mediante verificación administrativa y conservan la referencia mínima necesaria. [NIST: verificación de identidad](https://pages.nist.gov/800-63-4/sp800-63a/ial-general/).

Los administradores y gestores municipales acceden mediante invitación autorizada, sin asignación de permisos por dominio de correo. Los municipios no disponen de un directorio global de cuentas. La coincidencia de nombres no permite fusionar identidades.

**Justificación:** la autenticación global evita registros repetidos, mientras los permisos delimitan el acceso a cada municipio. Las membresías de Better Auth no sustituyen las políticas sobre los datos del dominio. [Better Auth Organization](https://better-auth.com/docs/plugins/organization).

## Autorización por operación

El sistema deniega por defecto y comprueba en servidor cuenta, objeto, acción, relación municipal y condiciones vigentes. El municipio o la finalidad enviados por el cliente no conceden autorización.

| Actor | Condición | Alcance |
|---|---|---|
| Usuario sin sesión | Instalación o unidad publicada | Catálogo y disponibilidad sin titulares. |
| Usuario autenticado | Titularidad | Reservas y datos propios. |
| Administrador municipal | Rol vigente en el municipio | Configuración y asignación de permisos de ese municipio. |
| Gestor municipal | Permiso vigente sobre operación y objeto | Unidades y datos municipales autorizados. |
| Usuario autorizado por convenio | Capacidad, finalidad y vigencia | Operación expresamente habilitada. |
| Operador de plataforma | Permiso operativo | Alta de municipios y operación de la instancia. |
| Worker | Tarea y contexto autorizados | Datos necesarios para ejecutar esa tarea. |

El plazo de aceptación de una invitación es independiente de la vigencia del rol concedido. La caducidad del rol se comprueba en cada operación, sin esperar a un proceso programado. Una delegación queda vinculada a la concesión que autorizó su emisión; renovar al emisor no reactiva invitaciones de una concesión anterior.

La revocación de un administrador conserva su perfil y las evidencias, pero invalida sus invitaciones pendientes. Recuperar el rol exige aceptar una nueva invitación emitida después de la revocación; no reactiva las anteriores.

Los permisos operativos no incluyen lectura general de reservas personales. Un acceso de soporte requiere autorización, caducidad y auditoría.

Una intervención administrativa no acredita aceptación del titular. Los eventos distinguen la operación administrativa de la aceptación personal; si el dato no consta en un evento anterior, no se infiere. Las normas y condiciones aceptadas conservan su versión e instante sin sobrescribir la evidencia previa.

El gestor necesita permiso sobre las unidades de origen y destino para reubicar. Solo el titular puede aceptar las normas asignadas a su reserva, con revisión y referencia exactas antes del inicio. La notificación del cambio, su entrega o la falta de respuesta no equivalen a aceptación.

**Justificación:** la combinación de rol, objeto y contexto limita el acceso que un rol genérico no puede expresar. [NIST ABAC](https://csrc.nist.gov/pubs/sp/800/162/upd2/final), [OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html).

## Aislamiento de datos

Las tablas municipales aplican RLS y referencias compuestas. El contexto se establece dentro de cada transacción y no persiste al devolver la conexión al pool. Los roles de ejecución no son propietarios, superusuarios ni tienen `BYPASSRLS`.

Las credenciales de autenticación, dominio y migraciones tienen permisos separados. La credencial de migraciones no está disponible en los procesos web. Las operaciones de colaboración acceden exclusivamente a las proyecciones y registros autorizados por el [contrato del convenio](07_identidad_y_colaboracion.md#persistencia-y-concurrencia).

**Justificación:** RLS limita filas, pero no sustituye la autorización por objeto y tiene excepciones para integridad y operaciones administrativas. [PostgreSQL RLS](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).

## Sesiones y protección de peticiones

- Las cookies de sesión utilizan `HttpOnly`, `Secure` y una política `SameSite` compatible con los flujos permitidos.
- Los orígenes confiables y redirecciones están restringidos; las rutas propias aplican protección CSRF.
- `cookieCache` permanece desactivado para comprobar la revocación en la siguiente petición. Las operaciones en curso respetan su orden transaccional.
- El acceso administrativo exige MFA. El alta de municipios y la aceptación de permisos administrativos exigen una verificación del segundo factor realizada hace menos de cinco minutos. Al caducar esta comprobación, la sesión continúa activa, pero la operación requiere verificar de nuevo el segundo factor. La recuperación de acceso no concede permisos adicionales.
- Los permisos se consultan en cada operación. El limitador de peticiones comparte estado entre réplicas y solo confía en los proxies configurados.
- La baja lógica requiere sesión válida, origen autorizado, confirmación expresa y contraseña actual. Si hay MFA, exige una verificación realizada hace menos de cinco minutos. Revoca todas las sesiones de la cuenta, incluidas las creadas concurrentemente, y bloquea nuevos accesos autenticados y operaciones de la cuenta. La cuenta desactivada no se reactiva mediante registro, recuperación de contraseña ni una invitación.

**Justificación:** evita prolongar sesiones o permisos revocados y mantiene los límites de acceso al distribuir peticiones entre réplicas. [Sesiones](https://better-auth.com/docs/concepts/session-management), [seguridad](https://better-auth.com/docs/reference/security), [límites](https://better-auth.com/docs/concepts/rate-limit).

## Baja y conservación

La comprobación de reservas confirmadas futuras o en curso de una baja abarca la cuenta en toda la instancia, sin devolver actividad de otros municipios. La auditoría conserva cuenta afectada, fecha, correlación y número de sesiones revocadas; no almacena tokens. Un fallo de auditoría revierte la baja y la revocación.

Desactivar la cuenta no borra identidad, perfiles, reservas ni auditorías. La supresión, el ejercicio de derechos y los plazos de conservación requieren una política aprobada del responsable del tratamiento; la baja no los sustituye ni ejecuta eliminaciones automáticas.

## Reactivación y recuperación

La reactivación ciudadana verifica contraseña, correo y TOTP o un código de respaldo si MFA estaba habilitado. El código de respaldo se consume atómicamente; nunca puede reutilizarse. El enlace contiene un token aleatorio de un solo uso; solo se conserva su resumen criptográfico, ligado al ciclo exacto de baja. Caduca a los diez minutos y admite cinco intentos. Los límites por dirección IP y cuenta se comparten entre réplicas. La solicitud no revela si una cuenta existe, está activa o está suspendida. La confirmación no crea una sesión ni recupera permisos administrativos.

La prueba de contraseña para darse de baja pertenece a la cuenta y sesión verificadas, caduca a los cinco minutos y no sirve después de cambiar la contraseña. El backend comprueba de nuevo sesión, credenciales y MFA en la transacción de baja. Una marca de sesión reciente no sustituye la contraseña solicitada para esta operación.

No se permite deshabilitar MFA mientras se conserven permisos administrativos vigentes. La sustitución de factores requiere verificar al titular; perder un factor no habilita una vía de menor seguridad.

Un administrador puede retirar inmediatamente todos los permisos e invitaciones pendientes de una cuenta en su municipio, con motivo, incluso si era el último administrador. No puede suspender la identidad global. Un operador puede suspenderla con MFA reciente; la suspensión bloquea nuevos accesos y conserva reservas y evidencias.

La recuperación municipal solo se inicia cuando no queda ningún administrador habilitado. Un operador registra el motivo y la referencia a la verificación externa de autoridad, e invita al sustituto; este acepta con correo verificado y MFA. La recuperación no concede al operador acceso a datos municipales. La primera inicialización permanece cerrada.

La gestión ordinaria de operadores utiliza invitaciones y revocaciones por API. La inicialización del primer operador y la recuperación sin operadores habilitados requieren credenciales operativas separadas. La recuperación asistida de una cuenta conserva referencias de identidad y resolución del compromiso; no presenta esas referencias como una verificación automática. Tras una suspensión se sustituyen contraseña, segundo factor y códigos de respaldo afectados antes de recuperar acceso personal. Los permisos se conceden nuevamente por los procedimientos ordinarios.

**Justificación:** la confirmación de una operación sensible, la recuperación de identidad y la asignación de autoridad son comprobaciones distintas. Separarlas evita utilizar una sesión robada o una recuperación de acceso para recuperar privilegios retirados. [OWASP: reautenticación](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html#require-re-authentication-for-sensitive-features), [OWASP: recuperación de MFA](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html#resetting-mfa).

## Convenios y trazabilidad

La activación requiere aprobación de finalidad, base jurídica, capacidades, unidades reservables, vigencia, datos necesarios, conservación y responsables. La revisión jurídica y del delegado de protección de datos precede a la activación. Cuando los participantes determinan conjuntamente fines y medios, se regulan las responsabilidades conforme al artículo 26 del RGPD. [RGPD, artículos 5, 6, 25 y 26](https://www.boe.es/doue/2016/119/L00001-00088.pdf).

La auditoría registra actor, municipio, convenio y versión cuando corresponda, operación, finalidad autorizada, instante y resultado. Excluye credenciales, tokens y documentos justificativos completos. Los agregados siguen sujetos a los controles de inferencia definidos para [C-03](07_identidad_y_colaboracion.md#c-03-informes-agregados).

## Controles de implantación

| Ámbito | Control |
|---|---|
| Protección de datos | Inventario de tratamientos, responsables y encargados, información a los usuarios, conservación, contratos y atención de derechos. |
| ENS | Determinación de alcance, categoría, riesgos y obligaciones del proveedor; controles y evidencias correspondientes. La certificación del alojamiento no sustituye la evaluación de la aplicación. |
| Accesibilidad | Revisión WCAG 2.1 AA automática y manual, con teclado, lector de pantalla, foco, contraste y errores; declaración aplicable al servicio. |
| Operación | Separación de secretos, datos y notificaciones por entorno; comunicaciones y copias cifradas, restauración verificada y actualización de dependencias. |

Referencias: [RD 311/2022](https://www.boe.es/eli/es/rd/2022/05/03/311/con), [WCAG 2.1](https://www.w3.org/TR/WCAG21/), [RD 1112/2018](https://www.boe.es/eli/es/rd/2018/09/07/1112/con).
