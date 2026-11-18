# 05 Seguridad y cumplimiento

## Identidad y acceso

Better Auth gestiona cuentas y sesiones. Cada cuenta identifica a un usuario del sistema; verificar el correo acredita acceso al buzón, no identidad civil ni residencia. Las acreditaciones de uso se conceden mediante verificación administrativa y conservan la referencia mínima necesaria. [NIST: verificación de identidad](https://pages.nist.gov/800-63-4/sp800-63a/ial-general/).

Los administradores y gestores municipales acceden mediante invitación autorizada, sin asignación de permisos por dominio de correo. Los municipios no disponen de un directorio global de cuentas. La coincidencia de nombres no permite fusionar identidades.

Las invitaciones que conceden autoridad municipal —primer administrador, administradores, gestores y sustituto de recuperación— se dirigen a una dirección de correo. Crear una invitación no consulta cuentas: la respuesta tiene el mismo estado, forma y coste exista o no una cuenta con esa dirección, y no devuelve nombres ni identificadores, igual que el registro; el formulario no sirve para averiguar quién está registrado. Solo la cuenta cuyo correo verificado coincide con la dirección ve la invitación y puede aceptarla, con MFA reciente; la comparación se repite al aceptar, de modo que la invitación sigue a la dirección si el correo de una cuenta cambia antes. Una cuenta con el correo sin verificar no la ve. Aceptarla vincula la invitación a la cuenta. Las invitaciones de operador y de privacidad global siguen el mismo modelo: un operador escribe el correo, nada se busca al crearla y solo la acepta la cuenta con ese correo verificado; el correo del propio operador se rechaza en la invitación de operador. Si la dirección ya tiene otra invitación de operador pendiente, se responde `409`: es un dato que el operador ya ve en su listado, no la existencia de una cuenta. Las invitaciones anteriores dirigidas a una cuenta siguen siendo válidas para ella. La suspensión o la baja de la cuenta que tiene verificada esa dirección retira también las invitaciones pendientes dirigidas a ella.

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
- Cerrar sesión revoca la sesión en la base de datos y caduca las cookies de Better Auth mediante `Set-Cookie`. Con `AUTH_CLEAR_SITE_COOKIES=true`, la respuesta correcta añade además `Clear-Site-Data: "cookies"`; nunca `"storage"` ni `"*"`, porque el almacenamiento local guarda preferencias del dispositivo que deben sobrevivir al cierre de sesión. Un cierre rechazado (origen no autorizado, límite de peticiones o error) no envía la cabecera. Los navegadores aplican esa directiva al dominio registrable completo: una instancia en `reservas.example.org` borraría también las cookies de `example.org` y de cualquier otro subdominio, como una sede electrónica o el consentimiento de cookies de la web municipal. Por eso está desactivada por defecto y solo debe activarse cuando el dominio registrable sirve únicamente esta instancia. nginx y Caddy reenvían la cabecera de la API sin modificarla.
- El acceso administrativo exige MFA. El alta de municipios y la aceptación de permisos administrativos exigen una verificación del segundo factor realizada hace menos de cinco minutos. Al caducar esta comprobación, la sesión continúa activa, pero la operación requiere verificar de nuevo el segundo factor. La recuperación de acceso no concede permisos adicionales.
- Los permisos se consultan en cada operación. El limitador de peticiones comparte estado entre réplicas y solo confía en los proxies configurados.
- La suscripción de calendario es la única URL que da acceso a datos personales sin sesión. La activa el titular, solo expone sus próximas reservas confirmadas, se guarda como resumen SHA-256, se puede regenerar o retirar y se retira al dar de baja, suspender o suprimir la cuenta.
- Las recomendaciones de horario se calculan en cada consulta solo con las reservas confirmadas de la propia cuenta, no se almacenan, no usan IA ni salen de la instancia, y el titular las desactiva desde su cuenta; la preferencia se incluye en la descarga de datos personales.
- La baja lógica requiere sesión válida, origen autorizado, confirmación expresa y contraseña actual. Si hay MFA, exige una verificación realizada hace menos de cinco minutos. Revoca todas las sesiones de la cuenta, incluidas las creadas concurrentemente, y bloquea nuevos accesos autenticados y operaciones de la cuenta. La cuenta desactivada no se reactiva mediante registro, recuperación de contraseña ni una invitación.

**Justificación:** evita prolongar sesiones o permisos revocados y mantiene los límites de acceso al distribuir peticiones entre réplicas. [Sesiones](https://better-auth.com/docs/concepts/session-management), [seguridad](https://better-auth.com/docs/reference/security), [límites](https://better-auth.com/docs/concepts/rate-limit).

## Cabeceras del origen web

La aplicación y la API se sirven bajo el mismo origen, por lo que la política de cabeceras tiene dos responsables.

**La API** (`src/http/security-headers.ts`) añade a toda respuesta `X-Content-Type-Options: nosniff` y, bajo `/api/` salvo `/api/public/`, `Cache-Control: no-store` cuando la ruta no fija otra política. Así, ninguna respuesta de cuenta, ni siquiera un error, queda en cachés compartidas o del navegador. El catálogo público conserva su caché.

**El borde que entrega la aplicación web** (proxy inverso o CDN) debe fijar, como requisito de despliegue:

| Cabecera | Valor mínimo | Motivo |
|---|---|---|
| `Content-Security-Policy` | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; report-uri /api/csp-reports; report-to csp` | Limita el origen de código y datos; impide el embebido; envía las infracciones al propio origen. |
| `Reporting-Endpoints` | `csp="/api/csp-reports"` | Destino del grupo `csp` de `report-to`. |
| `Strict-Transport-Security` | `max-age=31536000` | Acceso solo por HTTPS. La imagen web no añade `includeSubDomains`: extenderlo a los subdominios corresponde a quien administra el dominio. |
| `X-Content-Type-Options` | `nosniff` | También para los activos estáticos. |
| `Referrer-Policy` | `no-referrer` | Los enlaces de acción llevan el secreto en el fragmento y no deben filtrarse. |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | La aplicación no usa esas capacidades. |
| `Cross-Origin-Opener-Policy` | `same-origin` | Aísla el contexto de navegación. |

`style-src 'unsafe-inline'` es necesario hoy porque la apariencia municipal inyecta un elemento `<style>` y algunos componentes usan atributos `style`. Sustituirlos por clases y variables CSS permitiría una política de estilos estricta y se trata como mejora posterior. La recarga automática ante un fragmento obsoleto y la ausencia de scripts en línea son compatibles con `script-src 'self'`. Antes de una nueva versión deben conservarse los activos de la anterior durante el plazo de las pestañas abiertas, o la aplicación mostrará la pantalla de recarga.

**Informes de infracción.** Los navegadores que aplican la Reporting API envían cada infracción a `POST /api/csp-reports` según `report-to csp`; los demás usan `report-uri`, que se mantiene como alternativa. El destino es del mismo origen, de modo que no se añade ningún tercero ni se amplía `connect-src`. No requiere sesión ni lee cookies, y cualquiera podría falsificar un informe, así que sirven para detectar errores de la política o inyecciones, no como prueba. La API acepta hasta 16 KiB, aplica un límite propio de 60 peticiones por minuto y dirección, responde `204` sin cuerpo y descarta los informes sobre páginas de otro origen. De cada informe solo registra directiva, origen del recurso bloqueado (o `inline`, `eval` y equivalentes; para `data:`, `blob:` y extensiones, solo el esquema), ruta de la página sin consulta ni fragmento, disposición y estado HTTP. El evento no conserva URL completas, muestras de código, archivo y línea de origen, referente, agente de usuario ni IP, y la API no escribe en la base de datos más que el contador HMAC del límite. La lectura de esos eventos se describe en [operación](12_operacion.md#infracciones-de-la-política-de-contenido).

## Fotografías del catálogo

Las fotografías de instalaciones y espacios son contenido público del municipio, no datos de las cuentas.
- **Lo que se guarda:** el servidor nunca conserva el archivo recibido. Reconoce el formato por su firma antes de decodificarlo, rechaza los formatos no admitidos, las imágenes animadas y las de más de 36 megapíxeles, y guarda su propia versión WebP, sin metadatos. Así se eliminan la ubicación GPS, la cámara y otros datos ocultos.
- **Personas:** el editor pide no subir fotos en las que se reconozca a personas ni matrículas.
- **Acceso:** las imágenes de recursos sin publicar solo las ven quienes pueden gestionarlos, por seguridad de filas. La ruta pública devuelve una foto solo mientras su instalación, y su espacio si lo tiene, están publicados.
- **Política de seguridad de contenidos:** no cambia. El recorte se previsualiza como imagen `data:` y las fotos se sirven desde el propio origen.

## Información al interesado y accesibilidad

Cada municipio publica su información sobre privacidad, su aviso legal y su declaración de accesibilidad, y el operador publica los de la instancia. Los campos son fijos: responsable y contacto, delegado de protección de datos, finalidades, base jurídica, destinatarios, plazos de conservación, ejercicio de derechos y autoridad de control; denominación, NIF, domicilio y contacto; y, para la accesibilidad, estado de conformidad, contenido no accesible, método y fecha de evaluación, medio de contacto y procedimiento de reclamación. No admiten formato ni enlaces. Cada publicación es una versión nueva y las anteriores no se modifican ni se borran.

La plataforma aporta la redacción estándar de cada página. En privacidad: qué datos trata, finalidades, base jurídica (artículo 6.1.b y 6.1.e del RGPD), destinatarios, conservación, derechos, reclamación ante la AEPD y qué guarda en el navegador. En el aviso legal: objeto, condiciones de uso, responsabilidad, propiedad intelectual con la oferta del código fuente y legislación aplicable. En accesibilidad: el compromiso del Real Decreto 1112/2018, cómo se diseña y prueba el servicio, el contacto y el procedimiento de reclamación. La lista del navegador se genera desde `web/src/app/storage-keys.ts` y una prueba falla si el código usa una clave que no aparece. Cada sección que la entidad publica sustituye la estándar. El responsable del tratamiento, el titular del sitio y el estado de conformidad solo los declara la entidad: mientras no los publique, esas secciones no aparecen, y la aplicación no los presume.

## Baja y conservación

La comprobación de reservas confirmadas futuras o en curso de una baja abarca la cuenta en toda la instancia, sin devolver actividad de otros municipios. La auditoría conserva cuenta afectada, fecha, correlación y número de sesiones revocadas; no almacena tokens. Un fallo de auditoría revierte la baja y la revocación.

Desactivar la cuenta no borra identidad, perfiles, reservas ni auditorías. La baja no sustituye el ejercicio de derechos ni aprueba una política de conservación. El worker ejecuta por separado las políticas aprobadas que correspondan a cada ámbito.

## Reactivación y recuperación

La reactivación ciudadana verifica contraseña, correo y TOTP o un código de respaldo si MFA estaba habilitado. El código de respaldo se consume atómicamente; nunca puede reutilizarse. El enlace contiene un token aleatorio de un solo uso; solo se conserva su resumen criptográfico, ligado al ciclo exacto de baja. Caduca a los diez minutos y admite cinco intentos. Los límites por dirección IP y cuenta se comparten entre réplicas. La solicitud no revela si una cuenta existe, está activa o está suspendida. La confirmación no crea una sesión ni recupera permisos administrativos.

La prueba de contraseña para darse de baja pertenece a la cuenta y sesión verificadas, caduca a los cinco minutos y no sirve después de cambiar la contraseña. El backend comprueba de nuevo sesión, credenciales y MFA en la transacción de baja. Una marca de sesión reciente no sustituye la contraseña solicitada para esta operación.

No se permite deshabilitar MFA mientras se conserven permisos administrativos vigentes. La sustitución de factores requiere verificar al titular; perder un factor no habilita una vía de menor seguridad.

Un administrador puede retirar inmediatamente todos los permisos e invitaciones pendientes de una cuenta en su municipio, con motivo, incluso si era el último administrador. La retirada incluye las invitaciones pendientes dirigidas a su correo verificado; la baja y la suspensión también las revocan en toda la instancia. Como la cuenta nunca las aceptó, cada revocación queda registrada en la invitación, con actor y motivo, sin anotar qué cuenta usaba la dirección. El administrador elige a la persona entre quienes ya figuran en sus tablas de personal —administradores, gestores y destinatarios de invitaciones pendientes—, sin escribir identificadores ni consultar otras cuentas. Una invitación por correo que nadie ha aceptado se retira por su dirección: se revocan, con motivo, todas las pendientes a esa dirección en el municipio, sin resolverla a una cuenta; la respuesta solo indica si había alguna pendiente. No puede suspender la identidad global. Un operador puede suspenderla con MFA reciente; la suspensión bloquea nuevos accesos y conserva reservas y evidencias.

El operador identifica la cuenta comprometida por su identificador o por su correo. La coincidencia por correo es exacta sobre la dirección normalizada (sin espacios ni mayúsculas) y se resuelve dentro de la propia suspensión, después de comprobar el permiso de operador y el MFA reciente: no admite coincidencias parciales, no lista cuentas ni devuelve nombres, y un correo desconocido, ambiguo o mal formado responde `404 NOT_FOUND` igual que un identificador desconocido. Es una excepción deliberada y acotada a la ausencia de directorio: el operador ya puede suspender cualquier cuenta por su identificador, la operación queda auditada con la cuenta afectada y el correo evita pedir un dato técnico a quien comunica el compromiso.

La recuperación municipal solo se inicia cuando no queda ningún administrador habilitado. Un operador registra el motivo y la referencia a la verificación externa de autoridad, e invita al correo del sustituto; este acepta con ese correo verificado y MFA. El correo del propio operador se rechaza y el operador emisor no puede aceptar la invitación aunque después verifique esa dirección. La recuperación no concede al operador acceso a datos municipales. La primera inicialización permanece cerrada.

La gestión ordinaria de operadores utiliza invitaciones y revocaciones por API. La inicialización del primer operador y la recuperación sin operadores habilitados requieren credenciales operativas separadas. La recuperación asistida de una cuenta conserva referencias de identidad y resolución del compromiso; no presenta esas referencias como una verificación automática. Tras una suspensión se sustituyen contraseña, segundo factor y códigos de respaldo afectados antes de recuperar acceso personal. Los permisos se conceden nuevamente por los procedimientos ordinarios.

**Justificación:** la confirmación de una operación sensible, la recuperación de identidad y la asignación de autoridad son comprobaciones distintas. Separarlas evita utilizar una sesión robada o una recuperación de acceso para recuperar privilegios retirados. [OWASP: reautenticación](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html#require-re-authentication-for-sensitive-features), [OWASP: recuperación de MFA](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html#resetting-mfa).

## Actuaciones de privacidad

`PRIVACY_READ` permite consultar las proyecciones personales autorizadas y los controles de conservación. `PRIVACY_EXECUTE` permite aprobar o retirar políticas, registrar excepciones y ejecutar actuaciones autorizadas. Ambos permisos son explícitos, limitados a un municipio o a la identidad global y requieren MFA verificado hace menos de cinco minutos. Un administrador deportivo o un operador no los obtiene por su rol. El ámbito global no concede acceso administrativo a los historiales municipales.

Una política identifica familia de datos, finalidad, responsable, aprobación externa, plazo y actuación. No existen periodos legales predeterminados. Cada ámbito tiene una política activa por familia; una nueva aprobación sustituye la anterior sin reescribir actuaciones realizadas. La aprobación debe cubrir el conjunto de registros seleccionado por esa familia: el sistema no deduce bases jurídicas ni clasifica automáticamente finalidades de textos libres.

El worker selecciona registros vencidos y vuelve a comprobar referencias, actividad vigente y excepciones dentro de la transacción. Un conflicto afecta al registro, no autoriza a eliminar sus dependencias. Las reservas en curso o futuras, los permisos activos, los envíos con concesión vigente y las evidencias compartidas sin autorización conjunta se preservan. Las excepciones de conservación se crean y retiran con autorización y motivo; no son una suspensión de cuenta ni una limitación general del tratamiento.

`ERASE` elimina los registros incluidos en la actuación. `BLOCK` los retira de las tablas ordinarias y conserva su contenido en un archivo restringido, con fecha de destrucción aprobada. El rol web, el worker y los delegados de privacidad no pueden leer ese contenido directamente. El acceso excepcional requiere el procedimiento operativo autorizado y queda auditado; la autorización debe corresponder a los supuestos legales aplicables. Las excepciones vigentes impiden destruir el archivo. [LOPDGDD, artículo 32](https://www.boe.es/buscar/act.php?id=BOE-A-2018-16673#a3-4).

La dirección de una invitación es un dato personal del destinatario, tenga o no cuenta. Se conserva solo mientras la invitación no se acepta: al aceptarla se sustituye por la cuenta vinculada. Si vence o se revoca sin aceptar, la política `AUTHORITY` la trata como un registro propio, anclado en la revocación o el vencimiento, que archiva la dirección y la retira de la invitación sin borrar su historial: la del municipio para invitaciones municipales y la global para las de operador y privacidad global. Mientras tanto, solo el emisor y los administradores del municipio, o los operadores en el caso global, la ven en el historial de invitaciones, y la cuenta con ese correo verificado en «Mi cuenta › Invitaciones».

Cada invitación dirigida a un correo envía un aviso a esa dirección. El mensaje es el mismo exista o no una cuenta con ella: indica el rol, el municipio o la plataforma y el plazo, explica que se acepta en «Mi cuenta › Invitaciones» con esa dirección verificada y la verificación en dos pasos, y enlaza a esa página sin tokens; no nombra al emisor ni a ninguna cuenta. La cola de avisos solo conserva la dirección mientras el envío es posible: se borra con el envío aceptado, se retira al agotar los intentos y desaparece con la revocación, la sustitución, la aceptación o la retirada de la dirección por la política `AUTHORITY`; una invitación vencida no se envía. El rol web no puede leer la cola y el worker solo la reclama mediante funciones acotadas, sin listar destinatarios. Invitar exige permiso de administrador u operador, MFA reciente y el límite de operaciones por cuenta; además, cada municipio encola como máximo 100 avisos en 24 horas para las invitaciones de su propio personal, y la plataforma en conjunto otros 100 para las que emiten los operadores, también la invitación inicial de un municipio, su sustitución y la recuperación; así el personal municipal no puede agotar el aviso de una recuperación. Por encima, la invitación se crea y puede aceptarse en la aplicación, pero no se envía aviso; este límite no depende de que existan cuentas.

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
