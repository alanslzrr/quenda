# 09 Navegación y recorridos

La interfaz sigue la jerarquía del [modelo de dominio](02_modelo_dominio.md): municipio, instalación y unidad reservable. En la interfaz pública la unidad reservable se denomina «espacio», porque puede ser una pista, una sala o un pabellón. Los recorridos aplican [CU-01](08_casos_de_uso.md#cu-01--consultar-catálogo-y-disponibilidad), [CU-02](08_casos_de_uso.md#cu-02--crear-una-reserva), [CU-03](08_casos_de_uso.md#cu-03--modificar-o-cancelar-una-reserva) y [CU-08](08_casos_de_uso.md#cu-08--consultar-el-historial-de-reservas) sin modificar sus reglas.

## Navegación principal

| Destino | Visible para | Ruta |
|---|---|---|
| Reservar | Todas las personas | Municipio favorito o `/reservar` |
| Gestión | Cuentas con contexto municipal o permiso de plataforma | Ámbito autorizado |
| Ajustes | Todas las personas; opciones según sesión | Cuenta, reservas, avisos, idioma, apariencia y cierre de sesión |

La cabecera mantiene estos destinos en escritorio y móvil; sin sesión ofrece acceso. La gestión municipal conserva su navegación lateral y los accesos de uso personal.

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

### Verificación de la mejora UX — 25 de octubre de 2026

- `pnpm check`: tipos, lint y 83 pruebas correctas.
- `pnpm --dir web check`: tipos, lint y 50 pruebas correctas.
- `PG_BIN=… pnpm test:integration`: 295 pruebas correctas con PostgreSQL 17.11.
- `PG_BIN=… pnpm --dir web test:browser`: 196 pruebas correctas, escritorio y móvil oscuro.
- Los cuatro escenarios nuevos de navegación, MFA, identidad del personal y centrado se repitieron cinco veces en ambos proyectos: 40 ejecuciones correctas.
- Contrato HTTP de las nuevas consultas comprobado además por separado: `no-store`, cursores inválidos, retirada de permisos y cierre de sesión.
- Build de producción correcto. Mantiene avisos de importaciones dinámicas que también tienen consumidores estáticos; no son errores de compilación.
- Revisión visual de la demo real: reserva, cuenta, instalaciones, personal, acreditaciones y revisión de privacidad. Verificada la caducidad real del MFA y su recuperación con un borrador intacto, sin enviarlo.

Los selectores no amplían la autoridad: los usuarios delegados conservan su ámbito,
los destinatarios externos no se convierten en un directorio consultable y los
identificadores siguen disponibles cuando son referencias técnicas necesarias.
La suite intensiva de informes respeta el plazo `Retry-After`; no desactiva el
límite real de solicitudes para hacer pasar la prueba.

### Corrección visual posterior — 25 de octubre de 2026

La revisión del usuario detectó defectos que las pruebas anteriores no cubrían:
enlaces de tabla convertidos en cápsulas, subrayados persistentes en el menú,
marcadores nativos de despliegue y una vista previa de apariencia aislada.

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
- No se cambian permisos, contratos del backend, ventana MFA ni reintentos de comandos.

La autoauditoría visual detectó además el envío implícito de botones auxiliares sin
tipo. Se interrumpió una ejecución de navegador para corregirlo antes de repetir la
validación. Las pruebas nuevas comprueban estilos calculados, foco, teclado, portales,
ausencia de escrituras incluso con el formulario de revocación válido y restauración
de ambos temas personales. Las capturas se revisan además de los resultados funcionales.

La entrada manual de acreditaciones no remonta el formulario con cada carácter ni
queda ligada a las opciones de la página actual del selector. Cambiar la referencia
desmarca la confirmación de revocación; no elimina la recuperación de comandos pendientes.

Validación final de esta corrección:

- `pnpm check`: 83 pruebas correctas, tipos y lint.
- `pnpm --dir web check`: 50 pruebas correctas, tipos y lint.
- `pnpm --dir web build`: correcto; mantiene avisos de empaquetado no bloqueantes.
- Suite completa Playwright: 204 pruebas correctas en escritorio y móvil oscuro.
- Los cuatro escenarios de corrección, repetidos cinco veces por proyecto: 40/40.
- `git diff --check`: sin errores.
- Demo real: tablas y menú sin las regresiones visuales; referencia sin triángulo;
  vista previa clara global sobre tema personal oscuro y salida con foco restaurado.
  No se publicaron cambios de apariencia ni se reinició la demo durante esta corrección.

La suite de integración backend no se repitió para esta corrección de frontend; sus
295 resultados anteriores pertenecen a la validación previa, no a esta ejecución.

## Historial de reservas

«Mis reservas» muestra primero la reserva más reciente por inicio y pagina de 20 en 20 con una clave de continuación opaca que codifica la clave de orden completa (inicio, identificador y municipio); una clave con otro formato se rechaza y la interfaz la recupera volviendo a leer desde la primera página. El filtro por municipio se alimenta de `GET /api/me/reservations/municipalities`, que solo refleja los municipios donde la propia cuenta tiene reservas, y por eso no depende de las páginas cargadas ni crea un directorio intermunicipal. Si dos municipios comparten nombre, el filtro añade el final de su identificador.

## Textos legales

El pie de página enlaza con «Privacidad», «Aviso legal» y «Accesibilidad». Dentro de un municipio (`/municipios/{tenantId}/…`) los enlaces apuntan a los textos de ese municipio; fuera de él, a los de la instancia (`/privacidad`, `/aviso-legal`, `/accesibilidad`). Al crear una cuenta se enlaza la información sobre privacidad. El administrador los publica desde «Textos legales» en la gestión del municipio (`/administracion/{tenantId}/textos-legales`) y el operador desde la sección del mismo nombre de la plataforma. Si una entidad aún no ha publicado un texto, la página muestra lo que hace la aplicación y un aviso de que falta el contenido propio de la entidad.

## Descargas

En «Gestión», los administradores descargan la copia del catálogo desde la página de instalaciones y las reservas en JSON o CSV desde «Exportar reservas». En el detalle de una reserva, el titular puede añadirla a su calendario (o quitarla, si está cancelada) y, en «Mis reservas», descargar las próximas. Son enlaces o botones de descarga: abrirlos no modifica nada, y los archivos no se conservan en el almacenamiento del navegador.
