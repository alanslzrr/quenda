# 08 Casos de uso

## Actores

| Actor | Interacción con Quenda |
|---|---|
| Usuario sin sesión | Consulta el catálogo, crea una cuenta o solicita recuperar acceso. |
| Usuario autenticado | Reserva, consulta sus datos y gestiona su cuenta. Es titular de sus reservas. |
| Administrador municipal | Configura su municipio, delega permisos y participa en el gobierno de convenios. |
| Gestor municipal | Opera sobre las instalaciones, reservas y datos incluidos en sus permisos. |
| Operador de plataforma | Incorpora municipios, gestiona operadores y contiene compromisos de identidad global. |
| Administrador del municipio emisor | Registra o revoca acreditaciones cuando el convenio designa a su municipio como emisor. |
| Destinatario de informe conjunto | Consulta agregados con permiso municipal `REPORT_READ` y evaluación favorable para su cuenta. |
| Personal con permisos de privacidad | Consulta o ejecuta actuaciones en el ámbito expresamente concedido. No constituye un rol obligatorio ni equivale a ser delegado de protección de datos. |
| Personal de operación autorizado | Ejecuta recuperaciones y accesos excepcionales con credenciales de mantenimiento separadas. |
| Canal de comunicaciones | Recibe los mensajes enviados por Quenda; su aceptación no acredita entrega al destinatario. |

Una persona puede ejercer varias funciones, sin que una amplíe los permisos de otra. Better Auth y el worker forman parte del sistema, no sustituyen al actor que autoriza una actuación. Véanse el [glosario](README.md#terminología), la [autorización por operación](05_seguridad_y_cumplimiento.md#autorización-por-operación), las [capacidades del convenio](07_identidad_y_colaboracion.md#capacidades-del-convenio), los [permisos de privacidad](07_identidad_y_colaboracion.md#permisos-de-privacidad) y la [recuperación controlada](05_seguridad_y_cumplimiento.md#reactivación-y-recuperación).

## Respuestas comunes

| Situación | Respuesta y consecuencia |
|---|---|
| Entrada inválida | Rechaza la solicitud con código y mensaje; los errores de esquema identifican los campos afectados. No aplica cambios parciales. |
| Sesión ausente o permiso insuficiente | Rechaza la operación sin revelar datos ni objetos ajenos. |
| MFA reciente exigido y vencido | Requiere verificar otra vez el segundo factor; no cierra por ello la sesión. |
| Reserva modificada por otra operación | Exige consultar su revisión actual antes de enviar otro cambio. |
| Respuesta perdida de un comando idempotente | Permite recuperar el resultado retenido con la misma clave y contenido, previa autorización. Reutilizar la clave con otros datos se rechaza. |

**Fundamento:** [RF-16](01_requisitos.md#requisitos-funcionales), [RNF-01, RNF-02 y RNF-15](01_requisitos.md#requisitos-no-funcionales), [contratos de interfaz](03_procesos_y_secuencias.md#contratos-de-interfaz), [idempotencia](03_procesos_y_secuencias.md#idempotencia) y [sesiones](05_seguridad_y_cumplimiento.md#sesiones-y-protección-de-peticiones). Las respuestas deben permitir corregir la solicitud sin exponer datos ajenos. Los flujos y mensajes se ofrecen en gallego y castellano y cumplen los requisitos de [accesibilidad y adaptabilidad](01_requisitos.md#requisitos-no-funcionales).

## CU-01 — Consultar catálogo y disponibilidad

- **Actor:** usuario, con o sin sesión.
- **Objetivo:** encontrar una unidad y un intervalo reservables.
- **Precondiciones:** acceso a la interfaz pública.

**Flujo principal**
1. El usuario selecciona un municipio o abre su enlace directo. Quenda muestra únicamente sus instalaciones publicadas.
2. Selecciona fecha y duración. Quenda muestra las unidades con al menos un intervalo completo disponible y sus horarios en hora local. Las duraciones proceden de la configuración municipal de cada unidad.
3. El usuario elige una franja para continuar en CU-02; la consulta no la reserva.

**Alternativas y excepciones**
- El usuario también puede abrir una unidad directamente y consultar su fecha y duración.
- La búsqueda permite continuar por las instalaciones restantes; una página sin coincidencias no implica que se haya agotado el catálogo.
- Una unidad retirada, incompleta o sin normas válidas no se ofrece.
- Los intervalos cerrados, ocupados o fuera de las reglas no aparecen como disponibles.
- Las horas inexistentes se omiten; las repetidas se distinguen por su desplazamiento UTC.

**Resultado esperado:** disponibilidad consultada sin crear un perfil municipal ni revelar titulares.

**Fundamento:** [RF-01 y RF-02](01_requisitos.md#requisitos-funcionales), [tiempo y publicación](02_modelo_dominio.md#tiempo-y-configuración-municipal) y [registro](03_procesos_y_secuencias.md#registro-y-administración). Consultar orienta la elección; solo la confirmación garantiza la reserva.

## CU-02 — Crear una reserva

- **Actor:** usuario autenticado.
- **Objetivo:** reservar una unidad completa para un intervalo.
- **Precondiciones:** cuenta verificada, datos municipales necesarios y unidad publicada.

**Flujo principal**
1. El usuario elige unidad e intervalo y acepta expresamente las normas y condiciones mostradas.
2. Quenda comprueba las versiones aceptadas, disponibilidad, reglas municipales y, si procede, elegibilidad y cuota del convenio.
3. Quenda confirma la reserva y genera el aviso interno y el correo.

**Alternativas y excepciones**
- Si ya no podrá cancelar por sí mismo, debe aceptar expresamente esa restricción antes de confirmar.
- Si cambian las condiciones, Quenda solicita revisarlas y aceptarlas: `CONDITIONS_CHANGED`. Si falta aceptación, no confirma.
- Un solape, cuota agotada o falta de elegibilidad impide la reserva sin revelar actividad ajena.
- Un fallo del correo no anula la confirmación.

**Resultado esperado:** una reserva confirmada con su ocupación, cuota y evidencia de aceptación, o rechazo sin efectos parciales.

**Fundamento:** [RF-03, RF-07, RF-11, RF-22 y RF-23](01_requisitos.md#requisitos-funcionales), [RN-02 y RN-06–RN-09](02_modelo_dominio.md#invariantes), [confirmación](03_procesos_y_secuencias.md#confirmación-de-reservas) y [capacidades del convenio](07_identidad_y_colaboracion.md#capacidades-del-convenio). La aceptación debe corresponder a lo que se confirma.

## CU-03 — Modificar o cancelar una reserva

- **Actor:** titular o gestor municipal autorizado.
- **Objetivo:** cambiar una reserva futura o cancelarla.
- **Precondiciones:** reserva consultada y acceso autorizado; para cambiarla, inicio futuro.

**Flujo principal**
1. El titular consulta la reserva y selecciona otra fecha, horario o unidad del mismo municipio.
2. Acepta las condiciones vigentes cuando no estén cubiertas por su aceptación anterior.
3. Quenda valida plazo, disponibilidad y cuota, aplica el cambio completo y genera los avisos.

**Alternativas y excepciones**
- **Cancelación:** libera ocupación y cuota solo al confirmarse. Nunca exige aceptar normas nuevas; repetir una cancelación no repite efectos.
- **Plazo vencido:** `RESERVATION_DEADLINE_PASSED`; reserva, ocupación y cuota se conservan. Modificar no permite eludirlo.
- **Intervención municipal:** antes del inicio y con motivo, el gestor autorizado puede cancelar excepcionalmente o reubicar con permisos sobre origen y destino. La reubicación es inmediata, conserva el plazo aceptado aplicado al nuevo inicio y avisa al titular.
- **Normas pendientes:** el titular consulta y acepta la unidad y versión asignadas antes del nuevo inicio, incluso dentro del plazo restringido. Aceptarlas no cambia horario, cuota ni cancelación. Si la reserva cambió, debe consultarla de nuevo.
- **Sin aceptación posterior:** no se cancela ni revierte la reubicación; el titular contacta con el municipio si discrepa. El gestor no acepta en su nombre.
- **Reserva histórica:** no se inventan aceptaciones. La modificación del titular exige las condiciones vigentes; la administrativa puede dejar normas pendientes.
- **Sin cambios o con conflicto:** no se crea un cambio ficticio; un conflicto conserva la reserva anterior. No se cambia titular ni municipio, ni se modifica o cancela tras el inicio.
- **Inasistencia:** el titular conserva su responsabilidad, historial y tiempo reservado, sin cancelación ni penalización automática. Puede reorganizar participantes si las normas lo permiten, sin transferir titularidad ni registrar jugadores.

**Resultado esperado:** modificación o cancelación confirmada y trazable, o reserva anterior conservada.

**Fundamento:** [RF-04, RF-05, RF-11 y RF-20](01_requisitos.md#requisitos-funcionales), [RN-06–RN-08](02_modelo_dominio.md#invariantes), [modificación y cancelación](03_procesos_y_secuencias.md#modificación-y-cancelación), [reubicación y aceptación](02_modelo_dominio.md#reubicación-administrativa-y-aceptación-posterior), [reservas históricas](02_modelo_dominio.md#reservas-anteriores-sin-evidencia) y [responsabilidad](02_modelo_dominio.md#cancelación-y-responsabilidad). La intervención administrativa no acredita aceptación del titular.

## CU-04 — Mantener catálogo y calendario

- **Actor:** administrador o gestor municipal autorizado.
- **Objetivo:** definir qué unidades ofrece el municipio y cuándo pueden reservarse.
- **Precondiciones:** municipio incorporado, sesión con MFA y permisos sobre la operación y los recursos.

**Flujo principal**
1. El actor registra la instalación y sus unidades; completa su ficha pública (dirección, ubicación, descripción, accesibilidad, contacto, tipo y aforo, en gallego y castellano); configura horarios, excepciones, duración, antelación y normas.
2. Solicita publicar una unidad físicamente independiente.
3. Quenda valida la configuración, registra la actuación y la incorpora al catálogo disponible.

**Alternativas y excepciones**
- Sin normas, mantiene el borrador y responde: «Añade las normas de uso para publicar esta unidad» (`USAGE_RULES_REQUIRED`).
- Un cambio de calendario o bloqueo incompatible con reservas confirmadas se rechaza hasta resolverlas mediante CU-03.
- Un bloqueo válido impide nuevas reservas en su intervalo.
- La ficha es opcional y se sustituye completa: un campo ausente se borra. Si otra persona la modificó antes, el guardado se rechaza por versión y no sobrescribe su cambio.
- Retirar una unidad la oculta sin borrar reservas ni historial. Cambiar normas no sobrescribe las versiones aceptadas.

**Resultado esperado:** catálogo y calendario persistidos sin invalidar reservas existentes.

**Fundamento:** [RF-08–RF-11 y RF-19](01_requisitos.md#requisitos-funcionales), [publicación y configuración](02_modelo_dominio.md#tiempo-y-configuración-municipal), [cambios de reglas](02_modelo_dominio.md#estados-y-cambios-de-reglas) y [mensajes](03_procesos_y_secuencias.md#contratos-de-interfaz). Retirar, cerrar y eliminar datos son operaciones distintas.

## CU-05 — Consultar indicadores o exportar datos municipales

- **Actor:** gestor municipal autorizado.
- **Objetivo:** conocer el uso reservado o obtener los datos permitidos.
- **Precondiciones:** MFA y `REPORT_READ` para indicadores. Exportar exige MFA reciente, `DATA_EXPORT` y lectura de reservas (`RESERVATION_READ` o `RESERVATION_MANAGE`) en el mismo ámbito.

**Flujo principal**
1. El gestor indica municipio, periodo y, cuando corresponda, unidad.
2. Quenda comprueba el ámbito y devuelve los indicadores o la exportación autorizada.
3. La exportación identifica formato, versión, municipio, periodo y entidades incluidas.

**Alternativas y excepciones**
- Sin tiempo ofertado, la ocupación se expresa como «no aplicable», no como cero.
- La exportación distingue normas aceptadas, pendientes y evidencia ausente.
- Una exportación de más de 366 días o 10.000 reservas se rechaza sin truncar datos.
- Un convenio no permite incorporar historiales de otros municipios.

**Resultado esperado:** información reproducible del ámbito autorizado, sin atribuir asistencia real.

**Fundamento:** [RF-12 y RF-18](01_requisitos.md#requisitos-funcionales), [RNF-07](01_requisitos.md#requisitos-no-funcionales), [indicadores](03_procesos_y_secuencias.md#indicadores-municipales) y [exportaciones](03_procesos_y_secuencias.md#contratos-de-interfaz). Los resultados describen reservas, no presencia física.

## CU-06 — Incorporar un municipio

- **Actor:** operador de plataforma.
- **Objetivo:** habilitar la administración de un nuevo municipio.
- **Precondiciones:** operador habilitado y MFA verificado hace menos de cinco minutos.

**Flujo principal**
1. El operador registra la configuración municipal y el destinatario de la primera invitación administrativa.
2. Quenda valida y persiste el municipio y la invitación, sin conceder todavía el permiso.
3. El destinatario se autentica y acepta la invitación vigente con MFA. Quenda habilita su administración municipal.

**Alternativas y excepciones**
- Datos inválidos impiden completar el alta.
- Una invitación vencida, revocada o presentada por otra cuenta no concede autoridad.
- El alta no concede al operador acceso general a los datos municipales.

**Resultado esperado:** municipio configurado; su primer administrador queda habilitado únicamente tras aceptar.

**Fundamento:** [RF-13 y RF-16](01_requisitos.md#requisitos-funcionales), [registro y administración](03_procesos_y_secuencias.md#registro-y-administración) y [sesiones](05_seguridad_y_cumplimiento.md#sesiones-y-protección-de-peticiones). Incorporar municipios requiere configuración, no una versión distinta del producto.

## CU-07 — Crear una cuenta y utilizar un servicio municipal

- **Actor:** usuario.
- **Objetivo:** disponer de una identidad para reservar en la instancia.
- **Precondiciones:** acceso al registro y a su correo.

**Flujo principal**
1. El usuario solicita el registro. Quenda valida sus datos y requiere verificar el correo.
2. El usuario verifica el buzón y se autentica mediante CU-09.
3. Al confirmar una reserva, Quenda crea la relación con ese municipio si no existe, sin pedir un perfil adicional.

**Alternativas y excepciones**
- Si ya tiene cuenta en la instancia, utiliza la misma en otro municipio.
- Consultar el catálogo no crea un perfil.
- Una instancia independiente exige su propia cuenta; no hay federación automática.

**Resultado esperado:** cuenta y relación municipal persistidas, sin permisos administrativos ni afiliación que deba cancelarse.

**Fundamento:** [RF-14 y RF-17](01_requisitos.md#requisitos-funcionales), [registro](03_procesos_y_secuencias.md#registro-y-administración) e [identidad global](07_identidad_y_colaboracion.md#identidad-global). Compartir autenticación no comparte historiales; verificar el correo no acredita identidad civil ni residencia.

## CU-08 — Consultar el historial de reservas

- **Actor:** usuario autenticado; gestor municipal para la consulta autorizada de su ámbito.
- **Objetivo:** conocer reservas conservadas y su situación actual.
- **Precondiciones:** sesión válida y titularidad o permiso sobre las reservas.

**Flujo principal**
1. El usuario solicita su historial y, si lo necesita, lo delimita por municipio.
2. Quenda devuelve sus reservas conservadas de la instancia, de la más reciente a la más antigua por inicio; a igual inicio, el orden es estable por identificador y municipio. El filtro ofrece los municipios donde la cuenta tiene reservas, con independencia de las páginas cargadas, sin constituir un directorio de municipios.
3. Al consultar una reserva, muestra su estado y la evidencia de normas aceptadas o pendientes.

**Alternativas y excepciones**
- El gestor solo obtiene reservas incluidas en sus permisos municipales.
- «Sin aceptación registrada» describe evidencia ausente; no cambia el estado de la reserva.
- `FINALIZADA` indica que terminó el intervalo, no que el titular asistió.

**Resultado esperado:** historial autorizado, sin acceso a reservas ajenas.

**Fundamento:** [RF-06](01_requisitos.md#requisitos-funcionales), [CU-08](03_procesos_y_secuencias.md#casos-de-uso), [identidad global](07_identidad_y_colaboracion.md#identidad-global) y [estados](02_modelo_dominio.md#estados-y-cambios-de-reglas). El estado actual se distingue del resultado original de un comando.

## CU-09 — Iniciar o cerrar sesión

- **Actor:** usuario.
- **Objetivo:** acceder con su identidad o terminar ese acceso.
- **Precondiciones:** cuenta verificada y habilitada para iniciar sesión; sesión activa para cerrarla.

**Flujo principal**
1. El usuario presenta sus credenciales y completa MFA cuando corresponda.
2. Quenda valida la identidad y establece la sesión, sin añadir permisos.
3. Al solicitar el cierre, Quenda revoca la sesión; no puede reutilizarse en la siguiente petición.

**Alternativas y excepciones**
- Credenciales inválidas o verificación incompleta impiden el acceso solicitado.
- Una cuenta desactivada utiliza CU-15; una suspensión requiere CU-16.
- No se permite deshabilitar MFA mientras se mantengan permisos administrativos vigentes.

**Resultado esperado:** sesión validada o revocada, con los permisos que ya correspondían a la cuenta.

**Fundamento:** [RF-14 y RF-16](01_requisitos.md#requisitos-funcionales), [sesiones](05_seguridad_y_cumplimiento.md#sesiones-y-protección-de-peticiones) y [recuperación](05_seguridad_y_cumplimiento.md#reactivación-y-recuperación). Autenticarse no equivale a obtener autoridad municipal.

## CU-10 — Gestionar un convenio

- **Actor:** administradores de los municipios participantes.
- **Objetivo:** habilitar capacidades compartidas con alcance y vigencia acordados.
- **Precondiciones:** administradores autorizados con MFA y unidades pertenecientes a sus municipios.

**Flujo principal**
1. Un administrador registra la versión con participantes, unidades, capacidades y condiciones del convenio.
2. Cada participante aprueba esa misma versión y sus unidades.
3. Con revisión jurídica registrada y configuración válida, se solicita la activación. Quenda concilia las reservas y habilita una única versión efectiva.

**Alternativas y excepciones**
- Una nueva versión requiere sus propias aprobaciones y conserva las anteriores como evidencia; aprobar no activa por sí solo.
- Sustituir o reactivar requiere nueva versión, aprobaciones y activación; no reinicia cuotas.
- Un participante puede suspender con motivo. La suspensión o el vencimiento impiden nuevas reservas y reprogramaciones, pero conservan las confirmadas.
- Las unidades no pasan automáticamente a acceso abierto; su reapertura exige configuración municipal.

**Resultado esperado:** capacidades habilitadas solo dentro de la versión y vigencia autorizadas, sin gestión ni historiales ajenos.

**Fundamento:** [RF-21–RF-24](01_requisitos.md#requisitos-funcionales), [RN-10](02_modelo_dominio.md#invariantes), [gobierno](07_identidad_y_colaboracion.md#gobierno-del-convenio), [cuotas](07_identidad_y_colaboracion.md#c-02-cuota-conjunta) y [suspensión](07_identidad_y_colaboracion.md#suspensión-y-vencimiento). Cada participante conserva el control sobre su ámbito.

## CU-11 — Recibir y consultar avisos de reserva

- **Actor:** titular; canal de comunicaciones como participante externo.
- **Objetivo:** conocer una confirmación, modificación o cancelación.
- **Precondiciones:** operación de reserva confirmada.

**Flujo principal**
1. Quenda registra el aviso interno e intenta enviar el correo.
2. El titular recibe o consulta el aviso, que describe el evento y su fecha.
3. Consulta la reserva enlazada para conocer su estado actual y las normas pendientes, si existen.

**Alternativas y excepciones**
- Un correo fallido queda sujeto a reintentos sin revertir la reserva.
- Puede recibirse un correo duplicado; no representa otra reserva.
- Recibir el aviso no acepta normas. Aceptarlas después no genera otro aviso de reprogramación.

**Resultado esperado:** información del evento separada del estado actual y de su entrega por correo.

**Fundamento:** [RF-07](01_requisitos.md#requisitos-funcionales), [RN-09](02_modelo_dominio.md#invariantes) y [avisos](03_procesos_y_secuencias.md#avisos). La aceptación del canal no garantiza recepción por el destinatario.

## CU-12 — Delegar permisos y relevar responsables

- **Actor:** administrador municipal u operador, según el ámbito; destinatario de la invitación.
- **Objetivo:** conceder o retirar autoridad sin interrumpir la responsabilidad ordinaria.
- **Precondiciones:** facultad para la operación y MFA reciente, tanto al delegar o retirar permisos como al aceptar una invitación.

**Flujo principal**
1. El emisor identifica cuenta, permisos, ámbito y vigencia. Quenda registra la invitación sin activar los permisos.
2. El destinatario acepta. Quenda verifica identidad y vigencia y concede solo el alcance invitado.
3. Para un relevo, el responsable solicita la retirada cuando otro está habilitado con permiso indefinido.

**Alternativas y excepciones**
- Invitación inválida o ajena: no se conceden permisos. Ampliarlos exige nueva aceptación.
- Si el sustituto ya dispone del permiso adecuado, no necesita otra invitación; uno temporal aceptado puede hacerse indefinido expresamente, con motivo.
- Retirar al último responsable ordinario se rechaza hasta resolver el relevo. La seguridad se trata en CU-16.
- Retirar al administrador invalida las invitaciones pendientes de su concesión; recuperar el rol no las reactiva.
- Los permisos de privacidad son explícitos e independientes; ni administración ni exportación deportiva los incluyen.

**Resultado esperado:** permisos concedidos o retirados con auditoría y continuidad, sin elevación implícita.

**Fundamento:** [RF-16, RF-17 y RF-25](01_requisitos.md#requisitos-funcionales), [autorización](05_seguridad_y_cumplimiento.md#autorización-por-operación), [continuidad](02_modelo_dominio.md#cuenta-y-continuidad-administrativa) y [permisos de privacidad](07_identidad_y_colaboracion.md#permisos-de-privacidad). Una misma cuenta puede ejercer funciones distintas sin mezclar sus ámbitos.

## CU-13 — Actualizar datos personales y correo

- **Actor:** usuario autenticado; personal de operación autorizado en recuperación asistida.
- **Objetivo:** mantener sus datos de cuenta.
- **Precondiciones:** cuenta habilitada; el cambio de correo exige contraseña actual y MFA reciente si está habilitado.

**Flujo principal**
1. El usuario comunica los cambios en sus campos permitidos. Quenda los valida sin alterar identificadores ni evidencias históricas. Puede cambiar idioma y claro/oscuro desde su perfil o el menú superior de ajustes; ambos accesos utilizan las mismas preferencias.
2. Para cambiar el correo, confirma sus credenciales, autoriza desde el buzón actual y verifica el nuevo.
3. Quenda sustituye el correo, registra la operación y revoca las sesiones. El usuario debe iniciar sesión de nuevo.

**Alternativas y excepciones**
- Confirmación ausente, vencida o invalidada por un cambio de credenciales o estado: el correo no se sustituye.
- Sin acceso al buzón anterior, se requiere recuperación asistida con verificación de identidad; el usuario sigue verificando el nuevo correo y sus credenciales.
- Un permiso municipal no permite cambiar unilateralmente la identidad global.

**Resultado esperado:** datos permitidos actualizados; correo cambiado únicamente tras completar las verificaciones.

**Fundamento:** [RF-17 y RF-29](01_requisitos.md#requisitos-funcionales) y [actualización y cambio de correo](07_identidad_y_colaboracion.md#actualización-y-cambio-de-correo). El control de un municipio no equivale al control de la cuenta global.

## CU-14 — Dar de baja la cuenta

- **Actor:** usuario autenticado.
- **Objetivo:** desactivar voluntariamente su cuenta global.
- **Precondiciones:** sesión válida y posibilidad de confirmar contraseña y MFA reciente, si está habilitado.

**Flujo principal**
1. El usuario solicita y confirma la baja con las verificaciones exigidas.
2. Quenda comprueba reservas de toda la instancia y continuidad administrativa.
3. Si procede, desactiva la cuenta, revoca sesiones, autoridad propia e invitaciones pendientes y confirma la baja.

**Alternativas y excepciones**
- Reserva confirmada futura o en curso: se informa del impedimento y no se desactiva la cuenta.
- Último responsable ordinario: debe completar antes el relevo de CU-12.
- La baja no cancela reservas, no retira permisos ya aceptados por otras personas y no suprime automáticamente datos.

**Resultado esperado:** cuenta desactivada sin nuevas operaciones, o rechazo sin cambios.

**Fundamento:** [RF-17](01_requisitos.md#requisitos-funcionales), [cuenta y continuidad](02_modelo_dominio.md#cuenta-y-continuidad-administrativa) y [baja y conservación](05_seguridad_y_cumplimiento.md#baja-y-conservación). Cerrar acceso y suprimir evidencias son actuaciones distintas.

## CU-15 — Reactivar una cuenta

- **Actor:** usuario con cuenta desactivada voluntariamente.
- **Objetivo:** recuperar su acceso personal.
- **Precondiciones:** cuenta conservada y capacidad de verificar contraseña, correo y MFA si estaba habilitado.

**Flujo principal**
1. El usuario solicita la reactivación con su contraseña.
2. Quenda envía una comprobación de correo de un solo uso. El usuario confirma el enlace, contraseña y segundo factor cuando corresponda.
3. Quenda reactiva el acceso personal; el usuario inicia una sesión nueva.

**Alternativas y excepciones**
- La respuesta inicial no revela si una cuenta existe o está suspendida.
- Una prueba vencida, reutilizada o inválida no reactiva la cuenta.
- Una suspensión exige CU-16. Una identidad ya suprimida requiere otro registro.
- No se recuperan permisos administrativos ni invitaciones anteriores.

**Resultado esperado:** acceso personal recuperado, sin sesión ni autoridad restauradas automáticamente.

**Fundamento:** [RF-17](01_requisitos.md#requisitos-funcionales) y [reactivación y recuperación](05_seguridad_y_cumplimiento.md#reactivación-y-recuperación). Verificar identidad no vuelve a conceder autoridad retirada.

## CU-16 — Contener un compromiso y recuperar acceso

- **Actor:** administrador municipal, operador o personal de operación autorizado, según la intervención.
- **Objetivo:** impedir accesos comprometidos y recuperar el servicio mediante verificación.
- **Precondiciones:** autorización para el ámbito, MFA exigido y motivo registrado.

**Flujo principal**
1. El actor indica cuenta, motivo y ámbito de contención.
2. Si actúa el administrador municipal, Quenda revoca permisos e invitaciones locales. Si un operador con MFA reciente suspende la identidad global, revoca sesiones y permisos administrativos en toda la instancia. Ninguna de las dos intervenciones cancela reservas.
3. La recuperación controlada verifica identidad o autoridad, resuelve el compromiso y registra la intervención.

**Alternativas y excepciones**
- La retirada local no bloquea el uso personal de otros municipios.
- La seguridad puede dejar temporalmente al ámbito sin responsable; no espera un relevo.
- Sin administrador habilitado, un operador invita a un sustituto tras verificar autoridad; este acepta con correo verificado y MFA.
- Sin operadores habilitados, la recuperación exige mantenimiento separado. Recuperar una cuenta no restituye permisos antiguos y exige sustituir las credenciales comprometidas.

**Resultado esperado:** acceso comprometido contenido y recuperación trazable, sin ampliar permisos.

**Fundamento:** [RF-16 y RF-17](01_requisitos.md#requisitos-funcionales) y [recuperación](05_seguridad_y_cumplimiento.md#reactivación-y-recuperación). La contención inmediata prima sobre la continuidad ordinaria, pero no autoriza accesos ajenos.

## CU-17 — Gestionar una acreditación de uso

- **Actor:** administrador del municipio designado como emisor por el convenio.
- **Objetivo:** registrar o retirar un derecho de uso verificado.
- **Precondiciones:** MFA reciente, municipio emisor habilitado y cuenta destinataria vinculada a su servicio municipal.

**Flujo principal**
1. Tras la verificación administrativa, el emisor registra cuenta, convenio, vigencia y referencia mínima de verificación.
2. Quenda conserva la acreditación y su emisor.
3. Al crear o modificar realmente una reserva, Quenda comprueba que cubra todo el intervalo cuando el convenio la exige. Cancelar o aceptar normas pendientes no requiere otra comprobación de elegibilidad.

**Alternativas y excepciones**
- Acreditación revocada, insuficiente o de emisor no autorizado: no permite confirmar la operación.
- Un fallo técnico tampoco concede elegibilidad.
- Si el emisor solicita revocarla, Quenda registra la revocación e impide decisiones posteriores con esa acreditación.
- El acceso abierto no exige acreditación. No hay consultas libres de personas, documentos adjuntos ni comprobación automática de residencia.

**Resultado esperado:** derecho registrado o revocado; su comprobación no expone expedientes ajenos.

**Fundamento:** [RF-22](01_requisitos.md#requisitos-funcionales), [C-01](07_identidad_y_colaboracion.md#c-01-acreditaciones-de-uso), [revocación concurrente](07_identidad_y_colaboracion.md#persistencia-y-concurrencia) y [aceptación posterior](03_procesos_y_secuencias.md#aceptación-de-normas-asignadas). La verificación administrativa precede a la concesión; Quenda no la deduce de la cuenta.

## CU-18 — Consultar un informe conjunto

- **Actor:** solicitante con `REPORT_READ` municipal; administradores participantes como revisores.
- **Objetivo:** conocer los agregados permitidos de un mes cerrado.
- **Precondiciones:** capacidad de informes habilitada, MFA, permiso municipal y evaluación favorable específica para el solicitante.

**Flujo principal**
1. El usuario solicita el informe de un convenio y mes publicado.
2. Quenda comprueba el permiso y la evaluación aplicable a su cuenta y municipio; entrega el agregado al propio solicitante.
3. Registra destinatario, corte y versión del control aplicado.

**Alternativas y excepciones**
- Si el total o una contribución municipal no alcanza el umbral establecido, el informe es «no publicable», no cero.
- Un riesgo de reconstrucción impide la publicación; corregir un mes requiere revisar su combinación con entregas anteriores.
- No se ofrecen filtros demográficos, fechas arbitrarias ni detalle individual o municipal.

**Resultado esperado:** informe autorizado o supresión expresa, sin revelar historiales.

**Fundamento:** [RF-24](01_requisitos.md#requisitos-funcionales), [RNF-03](01_requisitos.md#requisitos-no-funcionales) y [C-03](07_identidad_y_colaboracion.md#c-03-informes-agregados). Agrupar datos no basta para garantizar anonimato.

## CU-19 — Obtener una copia de datos personales

- **Actor:** usuario autenticado o personal con `PRIVACY_READ` del ámbito.
- **Objetivo:** obtener los datos accesibles del interesado.
- **Precondiciones:** titularidad para autoservicio; permiso explícito, MFA reciente, motivo y autorización para la vía administrativa.

**Flujo principal**
1. El usuario solicita su descarga. Quenda toma la identidad de su sesión y reúne los campos accesibles de la instancia.
2. Devuelve el archivo con su alcance parcial y las categorías restringidas.
3. Registra la entrega; la información adicional se tramita por la vía administrativa.

**Alternativas y excepciones**
- El personal municipal prepara solo datos de su municipio; el permiso global cubre identidad y seguridad, no historiales municipales.
- Una cuenta inactiva puede atenderse administrativamente sin reactivarla.
- Si se supera el volumen admitido, no entrega un archivo truncado: requiere preparación administrativa.
- No incluye secretos, contenido bloqueado ni información de terceros pendiente de revisión.

**Resultado esperado:** copia identificada como `PARTIAL`, nunca como resolución completa del derecho de acceso.

**Fundamento:** [RF-25 y RF-27](01_requisitos.md#requisitos-funcionales), [descarga personal](07_identidad_y_colaboracion.md#descarga-personal) y [acceso y rectificación](05_seguridad_y_cumplimiento.md#acceso-personal-y-rectificación). Una descarga técnica no sustituye la información ni la resolución del responsable.

## CU-20 — Aplicar una política de conservación

- **Actor:** personal con `PRIVACY_EXECUTE` del ámbito.
- **Objetivo:** ejecutar los vencimientos conforme a una política aprobada.
- **Precondiciones:** aprobación administrativa previa, permiso explícito, MFA reciente y plazos definidos por el responsable.

**Flujo principal**
1. El actor registra ámbito, familia, finalidad, responsable, aprobación, plazo y actuación; si bloquea datos, también la duración autorizada del archivo.
2. Quenda activa la política y procesa automáticamente los registros elegibles, comprobando excepciones y dependencias.
3. Registra cada actuación; señala los conflictos sin eliminar los datos afectados.

**Alternativas y excepciones**
- Sin política aprobada no selecciona registros ordinarios para eliminación automática.
- Registrar o levantar una excepción exige autorización, motivo y un registro o interesado existente.
- Una excepción impide la destrucción correspondiente; no suspende el tratamiento ordinario ni la revocación de credenciales.
- Una nueva aprobación sustituye la política anterior. Revocarla detiene nuevas actuaciones sobre registros ordinarios, pero no recupera datos ni amplía la conservación autorizada de archivos bloqueados.
- Un conflicto no detiene los demás registros elegibles. Consultar controles requiere además `PRIVACY_READ`.

**Resultado esperado:** vencimientos ejecutados y auditados por ámbito, sin aprobaciones repetidas ni plazos predeterminados.

**Fundamento:** [RF-25 y RF-26](01_requisitos.md#requisitos-funcionales), [políticas](02_modelo_dominio.md#políticas-por-ámbito), [excepciones](02_modelo_dominio.md#ejecución-y-excepciones) y [worker](04_arquitectura.md#adr-07-outbox-y-worker). Cada municipio conserva su política aunque comparta instancia.

## CU-21 — Ejecutar una actuación individual de privacidad

- **Actor:** personal con `PRIVACY_EXECUTE` del ámbito.
- **Objetivo:** suprimir o bloquear un conjunto autorizado.
- **Precondiciones:** actuación valorada por el responsable, permiso explícito, MFA reciente, autorización y motivo.

**Flujo principal**
1. El actor identifica familia, registro y actuación; para bloquear, indica también la duración autorizada.
2. Quenda comprueba ámbito, excepciones y dependencias.
3. Ejecuta la actuación y registra el resultado, o conserva los datos si no procede.

**Alternativas y excepciones**
- `APPLIED` acredita la actuación; `CONFLICT` indica un impedimento; `ABSENT`, que no existe el conjunto operativo solicitado. Los tres resultados quedan auditados.
- Reservas vigentes, evidencias protegidas o referencias compartidas impiden eliminar unilateralmente el conjunto afectado.
- `BLOCK` retira el contenido del uso ordinario y lo conserva restringido. Los permisos de privacidad no permiten leer ese archivo; su acceso excepcional exige mantenimiento autorizado y auditado.
- Suprimir un perfil no cierra la cuenta global; retirar la identidad impide recuperarla mediante reactivación.

**Resultado esperado:** actuación aplicada o impedimento registrado, sin supresión parcial ni acceso a otros ámbitos.

**Fundamento:** [RF-28](01_requisitos.md#requisitos-funcionales), [RNF-03](01_requisitos.md#requisitos-no-funcionales), [ejecución](02_modelo_dominio.md#ejecución-y-excepciones), [supresión y bloqueo](02_modelo_dominio.md#supresión-y-bloqueo) y [acceso excepcional](05_seguridad_y_cumplimiento.md#actuaciones-de-privacidad). La autorización concreta no se presume por disponer del permiso técnico.

## CU-22 — Recuperar una instancia sin rehabilitar datos restringidos

- **Actor:** personal de operación autorizado.
- **Objetivo:** recuperar el servicio preservando integridad y actuaciones de privacidad.
- **Precondiciones:** copia disponible, credenciales operativas separadas y procedimiento autorizado.

**Flujo principal**
1. El actor restaura la copia en un destino cerrado al acceso ordinario.
2. Contrasta un checkpoint externo actualizado y reproduce las actuaciones de privacidad posteriores; Quenda conserva su evidencia.
3. Revisa integridad, excepciones, políticas, sesiones y envíos pendientes antes de autorizar la reapertura.

**Alternativas y excepciones**
- Sin evidencia suficiente y actual, o ante un conflicto, el destino permanece cerrado.
- Un checksum no acredita que el checkpoint sea el último; una copia antigua no contiene necesariamente las actuaciones posteriores.
- Reproducir el diario no autoriza por sí solo la reapertura ni permite ignorar excepciones de conservación.

**Resultado esperado:** instancia recuperada y revisada, o acceso bloqueado hasta resolver los impedimentos.

**Fundamento:** [RNF-10 y RNF-14](01_requisitos.md#requisitos-no-funcionales), [conservación en restauraciones](05_seguridad_y_cumplimiento.md#conservación-en-copias-y-restauraciones) y [requisitos de implantación](06_decisiones_y_validacion.md#requisitos-de-implantación). Recuperar disponibilidad no permite rehabilitar datos suprimidos o restringidos.

## CU-23 — Configurar la apariencia pública

- **Actor:** administrador municipal.
- **Objetivo:** aplicar la identidad visual permitida a la interfaz pública de su municipio.
- **Precondiciones:** permiso vigente y MFA reciente para guardar.

**Flujo principal**
1. El administrador abre «Apariencia», selecciona una combinación predefinida para cada modo y el modo inicial.
2. Quenda aplica temporalmente el borrador a toda la aplicación visible, sin publicar ni cambiar preferencias; salir, descartar o recargar termina la vista previa.
3. Al guardar, comprueba permisos y revisión, persiste la configuración y registra la actuación.

**Alternativas y excepciones**
- Restaurar aplica la combinación neutra en ambos modos y el modo claro mediante la misma operación de guardado.
- Una revisión obsoleta exige consultar la configuración actual; no sobrescribe el cambio de otro administrador.
- Fuera de la vista previa, la elección personal de claro/oscuro prevalece sobre el modo inicial del municipio.
- Salvo durante la vista previa temporal, la administración conserva el tema de Quenda. No se admiten colores libres ni estilos por componente.

**Resultado esperado:** apariencia pública persistida únicamente en el municipio autorizado.

**Fundamento:** [RF-30](01_requisitos.md#requisitos-funcionales), [RNF-02 y RNF-04](01_requisitos.md#requisitos-no-funcionales) y [apariencia y preferencias](02_modelo_dominio.md#apariencia-y-preferencias). Las combinaciones cerradas mantienen contraste y coherencia sin exponer un editor de estilos.

Referencia de estructura: [IBM — Use case specification outline](https://www.ibm.com/docs/en/engineering-lifecycle-management-suite/doors-next/7.2.0?topic=cases-use-case-specification-outline).
