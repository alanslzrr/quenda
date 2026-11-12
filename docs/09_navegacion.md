# 09 Navegación y recorridos

La interfaz sigue la jerarquía del [modelo de dominio](02_modelo_dominio.md): municipio, instalación y unidad reservable. En la interfaz pública la unidad reservable se denomina «espacio», porque puede ser una pista, una sala o un pabellón. Los recorridos aplican [CU-01](08_casos_de_uso.md#cu-01--consultar-catálogo-y-disponibilidad), [CU-02](08_casos_de_uso.md#cu-02--crear-una-reserva), [CU-03](08_casos_de_uso.md#cu-03--modificar-o-cancelar-una-reserva) y [CU-08](08_casos_de_uso.md#cu-08--consultar-el-historial-de-reservas) sin modificar sus reglas.

## Navegación principal

| Destino | Visible para | Ruta |
|---|---|---|
| Reservar | Todas las personas | Municipio favorito o `/reservar` |
| Gestión | Cuentas con contexto municipal o permiso de plataforma | Ámbito autorizado |
| Ajustes | Todas las personas; opciones según sesión | Cuenta, reservas, avisos, idioma, apariencia y cierre de sesión |

La cabecera mantiene estos destinos en escritorio y móvil; sin sesión ofrece acceso. En móvil, con sesión iniciada y un solo destino, este se muestra compacto junto a Ajustes; con varios destinos, o sin sesión (cuando también aparece Acceder), ocupan una fila propia. Si el nombre «quenda» no cabe junto a los destinos, la cabecera muestra solo el símbolo y el nombre se conserva como texto accesible del enlace. La navegación lateral de «Mi cuenta» solo lista los ajustes de la cuenta; «Mis reservas» y «Avisos» son páginas propias, accesibles desde las pestañas de reserva y desde Ajustes. La gestión municipal conserva su navegación lateral y los accesos de uso personal.

«Gestión» se muestra a partir de `/api/me/navigation`. Esa proyección orienta la navegación pero no autoriza: cada operación conserva su comprobación de permiso, ámbito y MFA. Las preferencias de la cuenta no enlazan a la gestión municipal. Como las lecturas privadas comparten un cupo por cuenta, la cabecera no consulta esa proyección dentro de la administración de un municipio y guarda solo el destino de «Gestión» en `sessionStorage`, asociado a la cuenta, durante un minuto; los cambios de permisos invalidan esa caché igual que el resto de la navegación.

## Recorrido de reserva

| Paso | Ruta | Contenido |
|---|---|---|
| 1. Municipio | `/` y `/reservar` | Municipio favorito en primer lugar y lista completa; búsqueda a partir de nueve municipios. |
| 2. Instalación | `/municipios/{tenantId}` | Instalaciones publicadas con el número de espacios reservables. Las que no tienen ninguno se muestran sin enlace y con el motivo. |
| 3. Espacio | `/municipios/{tenantId}/instalaciones/{facilityId}` | Espacios con su rango de duración. |
| 4. Día y hora | `/municipios/{tenantId}/unidades/{unitId}` | Día, duración y franjas libres. |
| 5. Revisión | `/municipios/{tenantId}/unidades/{unitId}/reservar` | Municipio, instalación, espacio, fecha, horario, duración, normas y condiciones. Requiere sesión. |
| Resultado | `/reservas/{tenantId}/{reservationId}` | Reserva confirmada, cambios, cancelación y acceso a una nueva reserva. |

Un indicador de pasos muestra el paso actual, los completados y los pendientes, con su estado también en texto para lectores de pantalla. Los pasos completados indican lo elegido y permiten volver a ellos con ratón o teclado. Cada página ofrece además un enlace para cambiar la elección anterior.

La búsqueda por día y hora en todas las instalaciones (`/municipios/{tenantId}/horarios`) se mantiene como alternativa para quien prioriza el horario.

## Contexto y cambios

- Día y duración viajan en la URL (`fecha`, `duracion`) entre los pasos 1 a 5, incluido volver a elegir municipio. Volver atrás, recargar o usar el historial del navegador conserva esas preferencias.
- Cambiar de municipio, instalación o espacio solo descarta las elecciones que dependen de él.
- «Reservar» en la navegación principal y «Nueva reserva» inician un recorrido nuevo: no arrastran fecha, duración ni una franja anterior. Los enlaces para cambiar un paso conservan únicamente fecha y duración, no identificadores de otra sede o pista ni una franja seleccionada.
- Si la duración o el día elegidos no son válidos en el nuevo espacio, se sustituye únicamente ese valor y se explica el ajuste.
- Los enlaces directos a un municipio, instalación o espacio reconstruyen el indicador con los datos públicos.
- Si un municipio, instalación o espacio ya no está disponible, la página lo indica y ofrece el paso anterior. Si era el municipio favorito, deja de serlo.
- Sin sesión, elegir una franja lleva al acceso con `returnTo`; tras acceder o registrarse se vuelve a la revisión de esa franja.
- Si la franja deja de estar libre antes de confirmar, la revisión informa de que no se ha creado ninguna reserva y enlaza con la elección de hora.

## Municipio favorito

El favorito se guarda solo en el navegador (`localStorage`, clave `quenda.municipality`), igual que las preferencias de visitante. No se asocia a la cuenta ni crea un perfil municipal, y no concede permisos. Cada navegador conserva el suyo y se elimina al borrar los datos del sitio. Se marca y se quita desde la lista de municipios o desde la página del municipio.

## Recuperación del límite de solicitudes

Una respuesta 429 conserva el plazo de `Retry-After`, tanto en segundos como en fecha HTTP. Si falta o no es válido, la interfaz utiliza una espera finita de 60 segundos. Muestra el tiempo restante sin anunciar cada segundo al lector de pantalla y habilita el reintento al terminar. No vuelve a enviar automáticamente una operación al agotarse el plazo ni pierde los parámetros de la reserva.

Las consultas no se repiten por recuperar el foco o la conexión mientras su plazo siga vigente. Una carga inicial fallida requiere recuperación expresa en vez de repetirse al remontar la vista. La paginación automática del catálogo y de la búsqueda también se detiene ante errores, aunque la página previa conserve un cursor siguiente. Los límites y las comprobaciones de permisos del backend no cambian.

## Composición y recuperación administrativa

La cabecera pública muestra Reservar y, cuando la proyección de permisos lo permite,
Gestión. Ajustes reúne cuenta, reservas propias, avisos, idioma, apariencia y cierre
 de sesión; se utiliza también en gestión. La navegación secundaria de reservas
mantiene el acceso al historial sin añadir una pantalla intermedia al recorrido.
Las rutas existentes y el favorito local del navegador se conservan.

Los contenedores de selección y reserva comparten un eje centrado de hasta 880 px;
cuenta utiliza una composición de hasta 980 px. Las tablas administrativas siguen
ocupando el área de trabajo disponible junto a la navegación municipal. Los enlaces
de acción son texto sin cápsulas, borde, fondo ni iconos añadidos, manteniendo semántica
de enlace, foco y apertura en otra pestaña. Se conservan los botones Lumen para acciones
primarias/secundarias; los enlaces dentro de prosa no se eliminan globalmente.

La recuperación MFA es contextual y compartida entre municipios, privacidad y
plataforma. Varios errores producen un solo aviso de verificación. Verificar refresca
consultas privadas de la cuenta, nunca reenvía comandos ni altera la ventana de cinco
minutos. Los errores recuperables de lectura mantienen los editores y borradores en memoria; la verificación no guarda ni reemplaza sus versiones de edición. La pérdida definitiva de permisos o de sesión retira el editor. Las protecciones de respuesta incierta permanecen activas.

Las acreditaciones de uso se emiten desde la versión de un convenio y se revocan
seleccionando una emisión propia. El listado está paginado y no revela referencias
de verificación ni emisiones ajenas. Se conserva la entrada por referencia conocida.
La revisión de privacidad selecciona convenio, mes preparado y destinatario. Solo
expone metadatos de revisiones, nunca cifras ni causas de supresión. No equivale a
publicar ni a conceder REPORT_READ. Para cuentas de otro municipio se solicita una
referencia facilitada por ese destinatario: no se crea un directorio intermunicipal.

Los selectores no amplían la autoridad: los usuarios delegados conservan su ámbito,
los destinatarios externos no se convierten en un directorio consultable y los
identificadores siguen disponibles cuando son referencias técnicas necesarias.

- `ActionLink` conserva la interacción de enlace sin heredar la caja de Button.
- Los enlaces de Ajustes tienen `text-decoration: none` en su estado permanente,
  no únicamente durante `starting-style`. Cuenta, reservas y avisos no añaden iconos.
- `Disclosure` compone un Button Lumen textual sin triángulo, con `aria-expanded`,
  `aria-controls` y contenido oculto que conserva el borrador. Declara `type="button"`
  para no activar la validación ni el envío de un formulario al desplegarlo.
- La vista previa aplica el borrador y su modo a la raíz de la aplicación: cabecera,
  navegación, contenido y portales. No escribe preferencias personales ni publica
  apariencia. Salir devuelve el foco al selector; descartar, salir de la página o
  recargar elimina la vista previa. Guardar sigue siendo la única publicación.
- Restaurar valores predeterminados modifica solo el borrador, sin enviar el formulario.

La entrada manual de acreditaciones no remonta el formulario con cada carácter ni
queda ligada a las opciones de la página actual del selector. Cambiar la referencia
desmarca la confirmación de revocación; no elimina la recuperación de comandos pendientes.

## Historial de reservas

«Mis reservas» muestra primero la reserva más reciente por inicio y pagina de 20 en 20 con una clave de continuación opaca que codifica la clave de orden completa (inicio, identificador y municipio); una clave con otro formato se rechaza y la interfaz la recupera volviendo a leer desde la primera página. El filtro por municipio se alimenta de `GET /api/me/reservations/municipalities`, que solo refleja los municipios donde la propia cuenta tiene reservas, y por eso no depende de las páginas cargadas ni crea un directorio intermunicipal. Si dos municipios comparten nombre, el filtro añade el final de su identificador.

## Textos legales

El pie de página enlaza con «Privacidad», «Aviso legal» y «Accesibilidad». Dentro de un municipio (`/municipios/{tenantId}/…`) los enlaces apuntan a los textos de ese municipio; fuera de él, a los de la instancia (`/privacidad`, `/aviso-legal`, `/accesibilidad`). Al crear una cuenta se enlaza la información sobre privacidad. El administrador los publica desde «Textos legales» en la gestión del municipio (`/administracion/{tenantId}/textos-legales`) y el operador desde la sección del mismo nombre de la plataforma. Cada página sigue la estructura habitual de su tipo. Mientras una entidad no publique su texto, las secciones generales muestran la redacción estándar del servicio, y las que solo puede escribir la entidad (responsable, titular del sitio, situación de cumplimiento) se omiten en lugar de mostrar un aviso de contenido pendiente.

## Descargas

En «Gestión», los administradores descargan la copia del catálogo desde la página de instalaciones y las reservas en JSON o CSV desde «Exportar reservas». En el detalle de una reserva, el titular puede añadirla a su calendario (o quitarla, si está cancelada). En «Mis reservas», «Añadir a mi calendario» abre un diálogo con las dos vías: descargar una vez las próximas reservas o crear la suscripción que se actualiza sola. Son enlaces o botones de descarga: abrirlos no modifica nada, y los archivos no se conservan en el almacenamiento del navegador.

## Sesión, contexto y actuaciones pendientes

Cada pantalla actualiza el título del documento desde sus encabezados visibles, también al cambiar de idioma o de cuenta. Los selectores usan su etiqueta traducida como texto inicial.

Ante una respuesta 401, la interfaz ofrece iniciar sesión y conserva la ruta y sus parámetros como destino de retorno. El acceso exige una acción expresa y no repite el comando que falló. Los marcadores de respuesta incierta pueden recuperarse tras autenticar de nuevo la misma cuenta; cerrar sesión explícitamente o cambiar de cuenta elimina todos los marcadores `quenda.*` de la pestaña y descarta consultas privadas.

Las altas de municipios, instalaciones y unidades conservan la clave idempotente y el contenido exacto ante una respuesta perdida. «Comprobar resultado» reutiliza ese comando durante el plazo publicado, exige autorización vigente y abre el recurso creado (o muestra la invitación inicial municipal). No se reenvía por montar la pantalla, recuperar la conexión o iniciar sesión. Las restantes actuaciones administrativas sin recibo idempotente mantienen su bloqueo y comprobación manual del resultado.

En «Conservación y derechos», la revisión compartida permite consultar una referencia conocida de reserva o acreditación, su municipio titular, actuación y plazo de bloqueo. Muestra los municipios responsables y sus aprobaciones, sin exponer el contenido personal. El municipio actual puede aprobar o retirar su aprobación con autorización y motivo. Esta revisión no ejecuta la supresión: la actuación individual o la política aplicable comprueban después unanimidad, elegibilidad y excepciones vigentes.
