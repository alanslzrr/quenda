# 06 Validación y requisitos de implantación

## Pruebas de aceptación

Cada prueba registra versión del sistema, datos, entorno, resultado y evidencias. Las pruebas HTTP utilizan `inject()`; la integridad, RLS y recuperación se verifican contra PostgreSQL. La accesibilidad combina herramientas automáticas y revisión manual.

| Prueba | Requisitos | Comprobación |
|---|---|---|
| T-01 | RF-01, RF-02, RF-08–RF-11 | Publicación, horarios, excepciones y normas producen el catálogo y la disponibilidad esperados. Las unidades sin normas no se ofrecen; la actualización conserva sus reservas y evidencias. |
| T-02 | RF-03; RNF-01 | Las solicitudes concurrentes sobre una franja no confirman más de una reserva. Con franja libre, comandos válidos y dependencias disponibles, una se confirma y las demás reciben un conflicto. |
| T-03 | RF-03; RNF-01 | Reintento concurrente, respuesta perdida y clave reutilizada con otro contenido: un único efecto, recuperación del resultado o rechazo de reutilización. |
| T-04 | RF-04–RF-06 | La modificación fallida y la cancelación rechazada conservan reserva, ocupación y cuota. La cancelación confirmada libera ambas. El historial distingue intervención administrativa y aceptación del titular. |
| T-05 | RF-10, RF-11, RF-19, RF-20 | Cambiar normas durante una confirmación rechaza la aceptación obsoleta sin efectos. Se prueban reubicación administrativa inmediata, evidencia preservada, reservas históricas y aceptación posterior exclusiva del titular. Cambios concurrentes de revisión o destino no aceptan otra referencia; publicar normas nuevas no sustituye las ya asignadas. Cancelar no exige aceptación nueva. |
| T-06 | RF-14, RF-16; RNF-02 | Una cuenta consulta sus reservas de varios municipios, no las ajenas; el gestor accede solo a los objetos autorizados. |
| T-07 | RNF-02 | API, formularios, exportaciones, worker y SQL de ejecución respetan ámbitos y capacidades en lecturas, escrituras, referencias y conexiones reutilizadas. |
| T-08 | RF-07; RNF-11 | Las caídas antes o después del envío y el vencimiento de concesiones no pierden eventos ni alteran reservas; se comprueban orden y duplicados. |
| T-09 | RF-12 | Los indicadores reproducen un conjunto conocido con calendario histórico, denominador cero, periodo y zona horaria. |
| T-10 | RF-13; RNF-08 | El alta de otro municipio y el despliegue de una instancia independiente utilizan los mismos artefactos sin cambiar código. La imagen web se ejecuta sin privilegios, aplica las cabeceras de seguridad, sirve la aplicación y los activos con hash con la caché prevista y delega la API en el backend. |
| T-11 | RF-14, RF-17 | Registro, invitaciones y cambios persisten tras reiniciar; rechazan entradas inválidas, duplicados y aumentos de permisos. Cerrar sesión impide reutilizarla. La baja exige contraseña actual y MFA reciente cuando esté habilitado; rechaza reservas futuras o en curso de cualquier municipio. Revoca sesiones y autoridad propia y se coordina con accesos, cambios de credenciales y reservas concurrentes. Reactivar verifica contraseña, correo y MFA sin restaurar permisos ni levantar suspensiones. Relevo, retirada por seguridad y recuperación preservan sus ámbitos y auditoría. |
| T-12 | RF-18; RNF-07 | La exportación v3 contiene el periodo y entidades autorizados, con normas aceptadas, pendientes y ausencia explícita de evidencia. Su esquema versionado puede validarse con herramientas independientes. |
| T-13 | RNF-04, RNF-05, RNF-15 | Teclado, lector de pantalla, contraste, zoom, móvil, movimiento reducido y traducciones permiten completar todos los flujos sin depender solo de color o arrastre. |
| T-14 | RF-25–RF-29; RNF-03, RNF-11 | Se verifican permisos explícitos de privacidad, MFA reciente, políticas independientes por municipio, ausencia de ejecución sin aprobación, excepciones, bloqueo, eliminación y auditoría atómica. La descarga personal declara sus exclusiones; el cambio de correo exige los dos buzones y no admite pruebas obsoletas. |
| T-15 | RNF-06, RNF-12 | Se respetan los límites entre módulos y se comprueban dependencias, licencias y atribuciones. |
| T-16 | RNF-09, RNF-13 | El escenario de rendimiento mide latencia, errores y capacidad, separando calentamiento y contención. |
| T-17 | RNF-10, RNF-14 | La restauración aislada conserva integridad, permisos, convenios, consumos y eventos. Una copia anterior a una supresión permanece cerrada hasta contrastar y reproducir el diario externo; repetir la conciliación no duplica archivos ni pierde las actuaciones en el siguiente checkpoint. |
| T-18 | RNF-07, RNF-08, RNF-14 | Se reconstruye el sistema en otro proveedor, se restauran datos y se registran las adaptaciones necesarias. |
| T-19 | RF-15 | Se verifica el mecanismo y la evidencia establecidos al resolver PD-AUTH-PUBLICA. |
| T-20 | RF-02–RF-05, RF-11 | Se prueban antelación, cambios horarios e intervalos contiguos; plazo de cancelación 0, 1.440 y otro valor, igualdad con el límite y vencimiento mientras se espera un bloqueo. Las reservas de última hora exigen aceptación de no cancelación. Las normas pendientes pueden aceptarse fuera del plazo de modificación, pero nunca desde el inicio. |
| T-21 | RF-21; RNF-02 | Aprobación, activación, sustitución, vencimiento y suspensión concurrente mantienen una sola versión efectiva y no amplían permisos unilateralmente. |
| T-22 | RF-22; RNF-03 | Se comprueban vigencia, revocación, cobertura temporal y emisor; se rechazan consultas sobre otra cuenta o búsquedas libres de acreditaciones. |
| T-23 | RF-23; RNF-01 | Dos municipios compiten por la última cuota de una cuenta: se admite como máximo un consumo. Se prueban semana, cancelación, cambio de unidad y reintentos. |
| T-24 | RF-23; RNF-11 | Versionar o retirar unidades no reinicia consumos. Reprogramar del convenio A al B libera A y consume B; un comando sin cambios conserva la atribución. |
| T-25 | RF-24; RNF-03 | Los controles detectan grupos pequeños y reconstrucciones en los casos de prueba mediante datos propios o entregas anteriores; suprimen los resultados inseguros sin representarlos como cero. |
| T-26 | RF-30; RNF-02, RNF-04, RNF-05 y RNF-15 | Se verifican apariencia por municipio, revisión concurrente, restauración de valores, auditoría atómica, contraste de las combinaciones, cambio de ámbito y preferencias compartidas entre perfil y menú superior. |
| T-29 | RF-33; RNF-02, RNF-07 | El catálogo exportado valida contra su esquema, refleja el estado del municipio, no incluye reservas ni datos personales ni datos de otros municipios, y solo lo obtiene el administrador con MFA reciente. |
| T-30 | RF-34, RF-35; RNF-02, RNF-07 | El CSV tiene las mismas filas que el JSON y neutraliza fórmulas. El archivo iCalendar se interpreta con un analizador independiente, conserva la identidad y sube la revisión, publica una cancelación como cancelada, se limita a 100 próximas reservas confirmadas y solo lo descarga el titular. La suscripción solo guarda el resumen del secreto, publica las reservas confirmadas futuras de su cuenta, deja de funcionar al regenerarla, retirarla o desactivar la cuenta, limita las peticiones por URL y aparece en la descarga de datos personales sin el secreto. |
| T-27 | RF-31; RNF-02, RNF-15 | La ficha se sustituye completa con permiso sobre el recurso y MFA reciente, rechaza versiones obsoletas y valores inválidos, deja auditoría con el estado anterior y el nuevo, no se muestra mientras el recurso no esté publicado y se presenta en el idioma activo o, si falta, en el otro. |
| T-28 | RF-32; RNF-03, RNF-04, RNF-15 | Los textos se publican por versiones, no admiten campos ajenos a su tipo ni fechas incoherentes, rechazan una versión obsoleta y publicaciones simultáneas, no pueden modificarse ni borrarse, solo los publica el propietario del ámbito con MFA reciente y las páginas públicas siguen la última versión con respaldo de idioma. La lista de almacenamiento del navegador coincide con el código. |
| T-32 | RF-37; RNF-02, RNF-03 | Un lector independiente decodifica el código con la página de la reserva. La llegada se registra solo con permiso sobre la unidad, MFA y origen autorizado, dentro de la ventana de acceso; repetirla conserva el primer registro, no crea eventos y el rol de la aplicación no puede escribirla directamente. Aparece en la descarga de datos personales. |
| T-33 | RF-38; RNF-02, RNF-04 | Un conjunto conocido reparte los minutos por día y hora local y por unidad con los mismos totales que los indicadores básicos; atribuye las cancelaciones, clasifica la antelación y cuenta las llegadas. El permiso de una unidad no abre el análisis municipal, no aparecen titulares y cada tono del mapa mantiene el contraste en modo claro y oscuro. |

## Escenario de rendimiento

| Parámetro | Valor |
|---|---|
| Datos | 3 municipios, 10 unidades reservables por municipio y 3.000 reservas históricas sintéticas. |
| Carga sostenida | 10 sesiones, 5 solicitudes/s durante 10 minutos; 80 % consultas y 20 % comandos. |
| Latencia de consultas | p95 ≤1 s con el servicio caliente. |
| Latencia de comandos válidos | p95 ≤1,5 s con el servicio caliente. |
| Contención | 100 comandos distintos sobre una misma franja libre. |

La medición registra cliente, región, capacidad asignada, p50/p95/p99, errores, abortos, conexiones y retraso de avisos. El calentamiento se mide por separado. La prueba de contención verifica integridad, no una capacidad de 100 reservas por segundo.

**Justificación:** un conjunto de datos y una carga estables permiten comparar versiones y detectar regresiones. Los compromisos de servicio y el dimensionamiento de producción se establecen para cada despliegue.

## Cierre de los hallazgos pendientes — 10 de noviembre de 2026

La implementación incorpora las migraciones `0099`–`0108`. La validación completa local (`PG_BIN=/opt/homebrew/opt/postgresql@17/bin pnpm validate`) terminó sin fallos: tipos y lint de backend y web, 104 pruebas unitarias/HTTP, 92 pruebas web, compilación web, 332 pruebas de integración PostgreSQL, 270 escenarios Playwright de escritorio y móvil, construcción de ambas imágenes y 5 pruebas OCI. No se omitieron pruebas. Permanecen advertencias de lint no bloqueantes. La composición de producción y el override de CA privada SMTP también pasaron `docker compose config --quiet`.

### Historial grande

`pnpm test:performance:history` pasó sobre `3532274`, con árbol limpio, PostgreSQL 17.11, 50.000 reservas históricas y 50.000 eventos. Se tomó una ejecución de calentamiento y cinco muestras por operación. Las páginas ejercitan el servicio de agenda con autorización y auditoría; no son latencias HTTP. La selección de conservación usa la función de candidatos empleada por el procesamiento.

| Operación | Mediana de cinco muestras calientes |
|---|---:|
| Primera página de agenda, 20 reservas | 3,47 ms |
| Página siguiente, 20 reservas | 3,37 ms |
| Agenda filtrada por el último día del conjunto | 8,61 ms |
| Selección de 100 candidatos de conservación | 269,20 ms |

La medición exploratoria anterior a los índices cronológicos, con los otros cambios en el árbol de trabajo, observó medianas de 2.059,25 ms y 2.019,93 ms en las dos primeras operaciones. Esa comparación previa tenía el árbol sucio; la medición final anterior identifica una revisión limpia. Los índices resuelven el recorrido cronológico sin introducir una proyección adicional. La selección de conservación incluye el último evento de consumo compartido, igual que la ejecución.

### Carga sostenida

`PG_BIN=/opt/homebrew/opt/postgresql@17/bin pnpm test:performance` aprobó el escenario completo sobre `3532274`, con árbol limpio: 60 segundos de calentamiento separado y 600 segundos de medición, 10 sesiones y 5 solicitudes/s. Las 2.400 consultas y 600 comandos resultaron válidos, sin errores de transporte, tiempos agotados ni sesiones ocupadas. El p95 HTTP fue 15,49 ms en consultas y 23,14 ms en comandos (límites de aceptación: 1.000 y 1.500 ms). Los 600 avisos del periodo quedaron aceptados, con p95 de 12,03 ms y ninguno pendiente; el transporte de correo es sintético en memoria.

Los informes completos se conservan fuera de Git en `.local/validation/audit-followups/`. Los tiempos corresponden a este equipo y a datos sintéticos; el ensayo no acredita capacidad de producción ni latencia de un proveedor SMTP externo.

## Requisitos de implantación

La implantación requiere artefactos reproducibles, migraciones versionadas, configuración de entorno, contratos API, pruebas de aceptación, manual operativo, alertas y restauración verificada. El despliegue identifica responsables, capacidad, contratos y validación municipal.

El procedimiento de recuperación comprueba reservas, ocupaciones, cuotas y actuaciones de privacidad antes de reabrir el servicio. La procedencia y actualidad del checkpoint se verifican fuera de la copia restaurada; un checksum no demuestra por sí solo que sea el último. Si el RPO admite pérdida de datos, concilia las reservas confirmadas que puedan verse afectadas. [PostgreSQL: replicación y durabilidad](https://www.postgresql.org/docs/current/warm-standby.html#SYNCHRONOUS-REPLICATION).

## Decisiones pendientes

| ID | Resolución necesaria | Dependencia |
|---|---|---|
| PD-AUTH-PUBLICA | Obtener de AGASOL el significado y la evidencia exigidos para «autenticación pública», sin incluir Cl@ve en el alcance inicial. | Aceptación de RF-15. |
| PD-OPERACION | Definir piloto, presupuesto, proveedor, región, capacidad, topología, disponibilidad, RTO, RPO, conservación y proveedor de correo. | Puesta en servicio de cada instancia. |
| PD-DEMO | Seleccionar alojamiento y configuración de ejecución con datos sintéticos. | Despliegue de la demo; misma funcionalidad y artefactos que el producto. |

### Propuesta de partida para PD-OPERACION

Valores para discutir con la entidad que opere la instancia; **no están aprobados** ni constituyen un compromiso de servicio. Cada uno debe confirmarse, ajustarse o rechazarse antes de la puesta en servicio.

| Aspecto | Propuesta de partida | Fundamento y comprobación |
|---|---|---|
| Piloto | Un municipio con una a tres instalaciones y personal gestor reducido. | Permite validar catálogo, reglas y avisos con datos reales antes de ampliar. |
| Topología | Un servidor con la [composición de referencia](../README.md#imagen-web-y-despliegue-de-referencia); PostgreSQL gestionado o con almacenamiento replicado si la entidad lo dispone. | La referencia no incluye alta disponibilidad; multizona y Kubernetes no son requisitos. |
| Capacidad | Partir de 2 vCPU, 4 GB de memoria y almacenamiento con margen para crecimiento y copias; ajustar con el ensayo de rendimiento de la instancia. | El escenario de rendimiento mide una configuración concreta, no una capacidad comprometida. |
| RPO | Máximo 24 horas con una copia lógica diaria; menos exige archivado continuo o réplica, con coste adicional. | Si el RPO admite pérdida, conciliar las reservas confirmadas posteriores al corte. |
| RTO | Máximo 4 horas con ensayo de restauración trimestral. | T-17 informa tiempos de una fixture pequeña; el RTO real debe medirse con los datos y el proveedor elegidos. |
| Conservación de copias | 30 días cifradas, con acceso restringido y una copia fuera del servidor principal. | Las copias contienen datos personales y material de autenticación. |
| Correo | SMTP de la entidad o de un proveedor contratado por ella, con TLS. | El worker usa la configuración SMTP existente; el proveedor y su contrato los determina la entidad. |
| Disponibilidad | Objetivo y horario de soporte a definir por la entidad. | Depende de topología, presupuesto y obligaciones del servicio. |
