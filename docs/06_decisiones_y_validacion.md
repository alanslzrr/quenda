# 06 Validación y requisitos de implantación

## Pruebas de aceptación

Cada prueba registra versión del sistema, datos, entorno, resultado y evidencias. Las pruebas HTTP utilizan `inject()`; la integridad, RLS y recuperación se verifican contra PostgreSQL. La accesibilidad combina herramientas automáticas y revisión manual.

| Prueba | Requisitos | Comprobación |
|---|---|---|
| T-01 | RF-01, RF-02, RF-08–RF-11 | Publicación, horarios, excepciones y normas producen el catálogo y la disponibilidad esperados. Las unidades sin normas no se ofrecen; la actualización conserva sus reservas y evidencias. |
| T-02 | RF-03; RNF-01 | Las solicitudes concurrentes sobre una franja no confirman más de una reserva. Con franja libre, comandos válidos y dependencias disponibles, una se confirma y las demás reciben un conflicto. |
| T-03 | RF-03; RNF-01 | Reintento concurrente, respuesta perdida y clave reutilizada con otro contenido: un único efecto, recuperación del resultado o rechazo de reutilización. |
| T-04 | RF-04–RF-06 | La modificación fallida y la cancelación rechazada conservan reserva, ocupación y cuota. La cancelación confirmada libera ambas. El historial distingue intervención administrativa y aceptación del titular. |
| T-05 | RF-10, RF-11, RF-19, RF-20 | Cambiar normas durante una confirmación rechaza la aceptación obsoleta sin efectos. Se prueban modificaciones administrativas, reservas anteriores sin evidencia y cancelación sin nueva aceptación. |
| T-06 | RF-14, RF-16; RNF-02 | Una cuenta consulta sus reservas de varios municipios, no las ajenas; el gestor accede solo a los objetos autorizados. |
| T-07 | RNF-02 | API, formularios, exportaciones, worker y SQL de ejecución respetan ámbitos y capacidades en lecturas, escrituras, referencias y conexiones reutilizadas. |
| T-08 | RF-07; RNF-11 | Las caídas antes o después del envío y el vencimiento de concesiones no pierden eventos ni alteran reservas; se comprueban orden y duplicados. |
| T-09 | RF-12 | Los indicadores reproducen un conjunto conocido con calendario histórico, denominador cero, periodo y zona horaria. |
| T-10 | RF-13; RNF-08 | El alta de otro municipio y el despliegue de una instancia independiente utilizan los mismos artefactos sin cambiar código. |
| T-11 | RF-14, RF-17 | Registro, invitaciones y cambios persisten tras reiniciar; rechazan entradas inválidas, duplicados y aumentos de permisos. Cerrar sesión impide reutilizarla. La baja rechaza reservas futuras de cualquier municipio, revoca todas las sesiones y se coordina con nuevos accesos y reservas concurrentes. |
| T-12 | RF-18; RNF-07 | La exportación versión 2 contiene el periodo y entidades autorizados, con evidencia de aceptación o ausencia explícita. Su esquema puede validarse con herramientas independientes. |
| T-13 | RNF-04, RNF-05, RNF-15 | Teclado, lector de pantalla, contraste, zoom, móvil, movimiento reducido y traducciones permiten completar todos los flujos sin depender solo de color o arrastre. |
| T-14 | RNF-03, RNF-11 | Se verifican minimización, conservación, derechos, auditoría y ausencia de secretos en registros. |
| T-15 | RNF-06, RNF-12 | Se respetan los límites entre módulos y se comprueban dependencias, licencias y atribuciones. |
| T-16 | RNF-09, RNF-13 | El escenario de rendimiento mide latencia, errores y capacidad, separando calentamiento y contención. |
| T-17 | RNF-10, RNF-14 | La restauración aislada conserva integridad, permisos, convenios, consumos y eventos; la recuperación de un despliegue fallido incluye migraciones y datos. |
| T-18 | RNF-07, RNF-08, RNF-14 | Se reconstruye el sistema en otro proveedor, se restauran datos y se registran las adaptaciones necesarias. |
| T-19 | RF-15 | Se verifica el mecanismo y la evidencia establecidos al resolver PD-AUTH-PUBLICA. |
| T-20 | RF-02–RF-05 | Se prueban antelación, cambios horarios e intervalos contiguos; plazo de cancelación 0, 1.440 y otro valor, igualdad con el límite y vencimiento mientras se espera un bloqueo. Las reservas de última hora exigen aceptación de no cancelación. |
| T-21 | RF-21; RNF-02 | Aprobación, activación, sustitución, vencimiento y suspensión concurrente mantienen una sola versión efectiva y no amplían permisos unilateralmente. |
| T-22 | RF-22; RNF-03 | Se comprueban vigencia, revocación, cobertura temporal y emisor; se rechazan consultas sobre otra cuenta o búsquedas libres de acreditaciones. |
| T-23 | RF-23; RNF-01 | Dos municipios compiten por la última cuota de una cuenta: se admite como máximo un consumo. Se prueban semana, cancelación, cambio de unidad y reintentos. |
| T-24 | RF-23; RNF-11 | Versionar o retirar unidades no reinicia consumos. Reprogramar del convenio A al B libera A y consume B; un comando sin cambios conserva la atribución. |
| T-25 | RF-24; RNF-03 | Los controles detectan grupos pequeños y reconstrucciones en los casos de prueba mediante datos propios o entregas anteriores; suprimen los resultados inseguros sin representarlos como cero. |

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

## Requisitos de implantación

La implantación requiere artefactos reproducibles, migraciones versionadas, configuración de entorno, contratos API, pruebas de aceptación, manual operativo, alertas y restauración verificada. El despliegue identifica responsables, capacidad, contratos y validación municipal.

El procedimiento de recuperación comprueba reservas, ocupaciones y cuotas antes de reabrir el servicio. Si el RPO admite pérdida de datos, concilia las reservas confirmadas que puedan verse afectadas. [PostgreSQL: replicación y durabilidad](https://www.postgresql.org/docs/current/warm-standby.html#SYNCHRONOUS-REPLICATION).

## Decisiones pendientes

| ID | Resolución necesaria | Dependencia |
|---|---|---|
| PD-AUTH-PUBLICA | Obtener de AGASOL el significado y la evidencia exigidos para «autenticación pública», sin incluir Cl@ve en el alcance inicial. | Aceptación de RF-15. |
| PD-BAJA-RESPONSABLE | Confirmar la política de relevo de la última cuenta operadora o administradora activa. La protección vigente rechaza su baja hasta disponer de otro responsable activo; no transfiere permisos automáticamente. | Baja de cuentas con responsabilidad operativa exclusiva. |
| PD-OPERACION | Definir piloto, presupuesto, proveedor, región, capacidad, topología, disponibilidad, RTO, RPO, conservación y proveedor de correo. | Puesta en servicio de cada instancia. |
| PD-DEMO | Seleccionar alojamiento y configuración de ejecución con datos sintéticos. | Despliegue de la demo; misma funcionalidad y artefactos que el producto. |
