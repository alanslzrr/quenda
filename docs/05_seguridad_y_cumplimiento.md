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

## Cabeceras del origen web

La aplicación y la API se sirven bajo el mismo origen, por lo que la política de cabeceras tiene dos responsables.

**La API** (`src/http/security-headers.ts`) añade a toda respuesta `X-Content-Type-Options: nosniff` y, bajo `/api/` salvo `/api/public/`, `Cache-Control: no-store` cuando la ruta no fija otra política. Así, ninguna respuesta de cuenta, ni siquiera un error, queda en cachés compartidas o del navegador. El catálogo público conserva su caché.

**El borde que entrega la aplicación web** (proxy inverso o CDN) debe fijar, como requisito de despliegue:

| Cabecera | Valor mínimo | Motivo |
|---|---|---|
| `Content-Security-Policy` | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` | Limita el origen de código y datos; impide el embebido. |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | Acceso solo por HTTPS. |
| `X-Content-Type-Options` | `nosniff` | También para los activos estáticos. |
| `Referrer-Policy` | `no-referrer` | Los enlaces de acción llevan el secreto en el fragmento y no deben filtrarse. |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | La aplicación no usa esas capacidades. |
| `Cross-Origin-Opener-Policy` | `same-origin` | Aísla el contexto de navegación. |

`style-src 'unsafe-inline'` es necesario hoy porque la apariencia municipal inyecta un elemento `<style>` y algunos componentes usan atributos `style`. Sustituirlos por clases y variables CSS permitiría una política de estilos estricta y se trata como mejora posterior. La recarga automática ante un fragmento obsoleto y la ausencia de scripts en línea son compatibles con `script-src 'self'`. Antes de una nueva versión deben conservarse los activos de la anterior durante el plazo de las pestañas abiertas, o la aplicación mostrará la pantalla de recarga.

## Baja y conservación

La comprobación de reservas confirmadas futuras o en curso de una baja abarca la cuenta en toda la instancia, sin devolver actividad de otros municipios. La auditoría conserva cuenta afectada, fecha, correlación y número de sesiones revocadas; no almacena tokens. Un fallo de auditoría revierte la baja y la revocación.

Desactivar la cuenta no borra identidad, perfiles, reservas ni auditorías. La baja no sustituye el ejercicio de derechos ni aprueba una política de conservación. El worker ejecuta por separado las políticas aprobadas que correspondan a cada ámbito.

## Reactivación y recuperación

La reactivación ciudadana verifica contraseña, correo y TOTP o un código de respaldo si MFA estaba habilitado. El código de respaldo se consume atómicamente; nunca puede reutilizarse. El enlace contiene un token aleatorio de un solo uso; solo se conserva su resumen criptográfico, ligado al ciclo exacto de baja. Caduca a los diez minutos y admite cinco intentos. Los límites por dirección IP y cuenta se comparten entre réplicas. La solicitud no revela si una cuenta existe, está activa o está suspendida. La confirmación no crea una sesión ni recupera permisos administrativos.

La prueba de contraseña para darse de baja pertenece a la cuenta y sesión verificadas, caduca a los cinco minutos y no sirve después de cambiar la contraseña. El backend comprueba de nuevo sesión, credenciales y MFA en la transacción de baja. Una marca de sesión reciente no sustituye la contraseña solicitada para esta operación.

No se permite deshabilitar MFA mientras se conserven permisos administrativos vigentes. La sustitución de factores requiere verificar al titular; perder un factor no habilita una vía de menor seguridad.

Un administrador puede retirar inmediatamente todos los permisos e invitaciones pendientes de una cuenta en su municipio, con motivo, incluso si era el último administrador. No puede suspender la identidad global. Un operador puede suspenderla con MFA reciente; la suspensión bloquea nuevos accesos y conserva reservas y evidencias.

La recuperación municipal solo se inicia cuando no queda ningún administrador habilitado. Un operador registra el motivo y la referencia a la verificación externa de autoridad, e invita al sustituto; este acepta con correo verificado y MFA. La recuperación no concede al operador acceso a datos municipales. La primera inicialización permanece cerrada.

La gestión ordinaria de operadores utiliza invitaciones y revocaciones por API. La inicialización del primer operador y la recuperación sin operadores habilitados requieren credenciales operativas separadas. La recuperación asistida de una cuenta conserva referencias de identidad y resolución del compromiso; no presenta esas referencias como una verificación automática. Tras una suspensión se sustituyen contraseña, segundo factor y códigos de respaldo afectados antes de recuperar acceso personal. Los permisos se conceden nuevamente por los procedimientos ordinarios.

**Justificación:** la confirmación de una operación sensible, la recuperación de identidad y la asignación de autoridad son comprobaciones distintas. Separarlas evita utilizar una sesión robada o una recuperación de acceso para recuperar privilegios retirados. [OWASP: reautenticación](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html#require-re-authentication-for-sensitive-features), [OWASP: recuperación de MFA](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html#resetting-mfa).

## Actuaciones de privacidad

`PRIVACY_READ` permite consultar las proyecciones personales autorizadas y los controles de conservación. `PRIVACY_EXECUTE` permite aprobar o retirar políticas, registrar excepciones y ejecutar actuaciones autorizadas. Ambos permisos son explícitos, limitados a un municipio o a la identidad global y requieren MFA verificado hace menos de cinco minutos. Un administrador deportivo o un operador no los obtiene por su rol. El ámbito global no concede acceso administrativo a los historiales municipales.

Una política identifica familia de datos, finalidad, responsable, aprobación externa, plazo y actuación. No existen periodos legales predeterminados. Cada ámbito tiene una política activa por familia; una nueva aprobación sustituye la anterior sin reescribir actuaciones realizadas. La aprobación debe cubrir el conjunto de registros seleccionado por esa familia: el sistema no deduce bases jurídicas ni clasifica automáticamente finalidades de textos libres.

El worker selecciona registros vencidos y vuelve a comprobar referencias, actividad vigente y excepciones dentro de la transacción. Un conflicto afecta al registro, no autoriza a eliminar sus dependencias. Las reservas en curso o futuras, los permisos activos, los envíos con concesión vigente y las evidencias compartidas sin autorización conjunta se preservan. Las excepciones de conservación se crean y retiran con autorización y motivo; no son una suspensión de cuenta ni una limitación general del tratamiento.

`ERASE` elimina los registros incluidos en la actuación. `BLOCK` los retira de las tablas ordinarias y conserva su contenido en un archivo restringido, con fecha de destrucción aprobada. El rol web, el worker y los delegados de privacidad no pueden leer ese contenido directamente. El acceso excepcional requiere el procedimiento operativo autorizado y queda auditado; la autorización debe corresponder a los supuestos legales aplicables. Las excepciones vigentes impiden destruir el archivo. [LOPDGDD, artículo 32](https://www.boe.es/buscar/act.php?id=BOE-A-2018-16673#a3-4).

Los identificadores conservados para integridad o recuperación siguen siendo datos personales cuando permiten vincular actividad. No se presentan como anónimos. La retirada de identidad global no borra unilateralmente evidencias municipales que aún dependan de ella; una identidad retirada no puede reactivarse. Los agregados solo se difunden conforme a los controles del convenio. [AEPD: anonimización](https://www.aepd.es/preguntas-frecuentes/0-conceptos-basicos/FAQ-0005-sobre-los-datos-anonimizados).

**Justificación:** los permisos separan la gestión deportiva de las actuaciones de privacidad; las selecciones cerradas y la conservación de dependencias evitan que una autorización municipal se convierta en una eliminación transversal.

## Acceso personal y rectificación

El usuario descarga una proyección de sus datos accesibles en la instancia. No contiene secretos de autenticación, identificadores de terceros ni motivos libres que requieran revisión. Declara su alcance parcial, las categorías restringidas y la información que debe tramitarse por la vía administrativa. Superar los límites de volumen rechaza la descarga; no trunca los datos silenciosamente. La consulta administrativa necesita permiso de privacidad del ámbito, MFA reciente, motivo y referencia de autorización; también admite titulares desactivados sin reactivar sus cuentas.

La descarga no se presenta como respuesta completa al derecho de acceso ni como reconocimiento automático del derecho de portabilidad. La respuesta administrativa incorpora la información del responsable, finalidades, destinatarios y conservación que corresponda. [AEPD: derecho de acceso](https://www.aepd.es/derechos-y-deberes/conoce-tus-derechos/derecho-de-acceso).

El cambio de correo comprueba contraseña actual y MFA cuando esté habilitado, obtiene autorización desde el buzón actual y verifica el nuevo. Las confirmaciones utilizan tokens de un solo uso ligados a la cuenta, sesión, credenciales y ciclo de actividad. El cambio final revoca las sesiones. Una suspensión, baja o cambio de credenciales invalida la prueba anterior. Las confirmaciones se ejecutan por POST; abrir un enlace no cambia la identidad ni crea una sesión.

Si el buzón anterior no está disponible, el procedimiento asistido registra la verificación externa de identidad y comprueba el nuevo correo. No sustituye contraseña ni MFA, no levanta suspensiones y no permite que un administrador municipal edite la identidad global.

## Conservación en copias y restauraciones

Una restauración permanece cerrada a los roles de ejecución y activa además una barrera de recuperación en la aplicación. Antes de reabrir se contrastan las actuaciones de supresión y bloqueo con un checkpoint externo actualizado, cuya procedencia, integridad y actualidad deben verificarse. Reproducir esas actuaciones no autoriza la reapertura por sí solo: también se revisan excepciones, políticas, integridad, sesiones y envíos pendientes.

Sin evidencia actual suficiente, el destino permanece cerrado. Un checkpoint guardado dentro de la misma copia antigua no demuestra qué actuaciones ocurrieron después. El diario de recuperación contiene referencias, no contenidos bloqueados; su conservación debe cubrir las copias recuperables y su posterior retirada requiere la política aprobada del responsable. Ni el diario ni la auditoría tienen una exención de conservación indefinida.

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
