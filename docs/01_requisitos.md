# 01 Requisitos del producto

## Alcance

El sistema permite consultar, reservar y administrar instalaciones deportivas municipales. Funciona como servicio compartido entre municipios o como instancia independiente, con el mismo código y componentes.

Cada usuario dispone de una cuenta global dentro de su instancia. Los datos y permisos municipales permanecen aislados; la colaboración entre municipios se limita a las operaciones autorizadas por un convenio.

Las reservas son puntuales y ocupan una unidad reservable completa. La antelación máxima es de 30 días naturales por defecto, configurable por municipio. Una unidad reservable puede reducir ese límite, pero no ampliarlo. El plazo ordinario de modificación y cancelación es de 24 horas antes del inicio por defecto, configurable por municipio. Los datos se introducen y mantienen mediante la aplicación.

Quedan fuera del alcance inicial los pagos, las reservas recurrentes, las subdivisiones de espacios, la importación de archivos, las aplicaciones nativas, los códigos QR, las listas de espera, la IA y la integración con Cl@ve. Tampoco se gestionan jugadores, transferencias de titularidad, tickets ni penalizaciones automáticas. Los abonos representan derechos de uso sin cobros ni facturación. Las instancias independientes no comparten identidad ni convenios entre sí.

Los actores y conceptos se definen en el [glosario](README.md#terminología). Las reglas temporales están en el [modelo de dominio](02_modelo_dominio.md#tiempo-y-configuración-municipal).

## Requisitos funcionales

| ID | Función | Criterio de aceptación |
|---|---|---|
| RF-01 | Consultar instalaciones | El usuario selecciona un municipio o accede mediante su enlace y consulta sus instalaciones publicadas. |
| RF-02 | Consultar disponibilidad | El sistema muestra los intervalos admitidos y comprueba de nuevo su disponibilidad al confirmar. |
| RF-03 | Crear una reserva | El usuario acepta las condiciones vigentes y recibe confirmación o rechazo con motivo. Si el plazo de cancelación ya ha vencido, acepta expresamente que no podrá cancelarla por sí mismo. |
| RF-04 | Modificar una reserva | La modificación del titular comprueba el plazo aceptado de origen y las condiciones del destino; aplica el cambio atómicamente o conserva la reserva anterior. |
| RF-05 | Cancelar una reserva | El sistema aplica el plazo aceptado y libera ocupación y cuota solo si confirma la cancelación. El rechazo conserva ambas. |
| RF-06 | Consultar el historial | El usuario accede a sus reservas conservadas; el gestor municipal, únicamente a las incluidas en sus permisos. |
| RF-07 | Recibir avisos | El sistema genera avisos internos y correos de confirmación, modificación y cancelación. |
| RF-08 | Crear instalaciones | El administrador o gestor municipal autorizado registra instalaciones de su municipio. |
| RF-09 | Mantener el catálogo | El sistema permite modificar o retirar instalaciones y unidades reservables sin borrar reservas ni alterar su historial. |
| RF-10 | Configurar horarios | El sistema calcula la disponibilidad con los horarios, excepciones y cierres vigentes. |
| RF-11 | Gestionar normas de uso | Publicar exige normas vigentes con contenido. El titular acepta las normas al reservar y, al modificar, cuando no están cubiertas por su evidencia. Una reubicación administrativa puede dejar las normas asignadas pendientes de aceptación antes del uso, sin atribuirla al gestor ni alterar la evidencia anterior. |
| RF-12 | Consultar indicadores municipales | Los resultados reproducen las [fórmulas de reservas y ocupación](03_procesos_y_secuencias.md#indicadores-municipales) para el municipio y periodo seleccionados. |
| RF-13 | Incorporar municipios | El operador de plataforma da de alta un municipio mediante configuración, sin modificar el código. |
| RF-14 | Gestionar cuentas y sesiones | El usuario crea una cuenta, inicia sesión y la cierra sin obtener permisos municipales automáticamente. |
| RF-15 | Cubrir la autenticación pública | El mecanismo y su evidencia de aceptación se determinan en [PD-AUTH-PUBLICA](06_decisiones_y_validacion.md#decisiones-pendientes). |
| RF-16 | Autorizar operaciones | El sistema deniega toda operación que no cumpla los permisos sobre municipio, objeto y acción. |
| RF-17 | Mantener datos desde la aplicación | La aplicación valida y persiste altas, cambios y bajas autorizadas. La baja global rechaza reservas confirmadas futuras o en curso y exige verificación de identidad y continuidad administrativa; la reactivación recupera solo acceso personal. La suspensión de seguridad y la recuperación están autorizadas y auditadas. No existe una baja de afiliación municipal. |
| RF-18 | Exportar datos municipales | El sistema entrega el conjunto autorizado en un formato abierto documentado, sin datos ajenos al ámbito solicitado. |
| RF-19 | Bloquear unidades reservables | El cierre impide nuevas reservas y se rechaza si afecta a reservas confirmadas no resueltas. |
| RF-20 | Administrar reservas | El gestor autorizado cambia fecha, horario o unidad y puede cancelar reservas futuras con motivo. La reubicación es inmediata y transaccional, notifica al titular y registra las normas pendientes cuando corresponda; no transfiere titularidad ni altera el plazo de cancelación aceptado. |
| RF-21 | Gestionar convenios | Los administradores participantes aprueban una versión con capacidades, unidades reservables y vigencia explícitas. |
| RF-22 | Comprobar elegibilidad | Durante un intento de reserva, el sistema comprueba el derecho de uso sin exponer expedientes ni historiales de otros municipios. |
| RF-23 | Aplicar cuotas conjuntas | La reserva y su consumo de cuota se confirman en una transacción; las solicitudes concurrentes no superan el límite. |
| RF-24 | Consultar informes conjuntos | Los usuarios autorizados reciben agregados del convenio sujetos a controles de inferencia y supresión. |
| RF-25 | Autorizar actuaciones de privacidad | Consulta y ejecución requieren concesiones explícitas independientes, delimitadas al municipio o a la identidad global y MFA reciente. Ser administrador u operador no las concede automáticamente. |
| RF-26 | Aplicar conservación aprobada | El sistema ejecuta automáticamente la política vigente de cada ámbito y familia de datos. Exige finalidad, responsable, aprobación y plazos explícitos; las excepciones o dependencias protegidas impiden únicamente la actuación afectada y quedan identificadas para revisión. |
| RF-27 | Facilitar acceso a datos personales | El usuario descarga sus datos accesibles de la instancia. La vía administrativa atiende otros supuestos, incluidas cuentas inactivas, con autorización y alcance delimitados. La descarga identifica restricciones y no se presenta como respuesta completa al derecho de acceso. |
| RF-28 | Ejecutar actuaciones individuales de privacidad | El personal con permiso específico registra autorización y motivo para suprimir o bloquear un conjunto admitido. El sistema distingue actuación realizada, conflicto y ausencia; conserva auditoría sin eliminar datos de otro ámbito. |
| RF-29 | Cambiar el correo global | El usuario confirma contraseña y MFA cuando corresponda, autoriza desde el correo actual y verifica el nuevo antes del cambio. La pérdida del correo anterior requiere recuperación asistida verificada; un permiso municipal no habilita esta operación. |
| RF-30 | Configurar apariencia municipal | El administrador selecciona combinaciones predefinidas para claro y oscuro, previsualiza, guarda o restaura los valores. Se aplican únicamente a la interfaz pública de su municipio, sin colores libres ni estilos por componente. |
| RF-31 | Describir instalaciones y espacios | El administrador o gestor autorizado completa la ficha de una instalación (dirección, ubicación, descripción, accesibilidad y contacto) y de sus espacios (tipo, interior o exterior, aforo y descripción), en gallego y castellano. Todos los campos son opcionales, no condicionan la publicación y se muestran en el catálogo público solo cuando el recurso está publicado. Cada cambio comprueba la versión conocida y queda auditado. |
| RF-32 | Publicar textos legales | El administrador de cada municipio y el operador de la instancia publican la información sobre privacidad, el aviso legal y la declaración de accesibilidad en gallego y castellano mediante campos fijos. Cada publicación crea una versión nueva que exige MFA reciente y la versión vigente como referencia; las versiones anteriores no se modifican. Las páginas públicas muestran el texto vigente, o el texto base de la aplicación con un aviso si aún no hay ninguno, y enumeran el almacenamiento que usa el navegador. |
| RF-33 | Exportar el catálogo | El administrador descarga un documento JSON versionado (`quenda.catalog`) con los ajustes del municipio, sus instalaciones y espacios con ficha, el calendario y las normas vigentes y el estado de publicación, con esquema y ejemplo validables. No contiene reservas ni datos personales. Es una copia de lectura; no hay importación de archivos. |
| RF-34 | Llevar una reserva al calendario personal | El titular descarga un archivo iCalendar (RFC 5545) de una reserva suya o de sus próximas reservas confirmadas, con horas en UTC, identidad estable y revisión como `SEQUENCE`. Una reserva cancelada se descarga como cancelada. Es una descarga autenticada y puntual: no hay enlaces de suscripción ni secretos. |
| RF-35 | Exportar reservas como tabla | La exportación de reservas admite además un CSV (RFC 4180, UTF-8 con marca de orden de bytes) con una fila por reserva y los mismos permisos que el JSON. Los valores que una hoja de cálculo ejecutaría como fórmula se neutralizan. |
| RF-36 | Instalar la aplicación | La aplicación web declara nombre, iconos y apertura en ventana propia, de modo que los navegadores que lo admiten la instalan en móvil, tableta u ordenador. Usa la misma interfaz y API; no hay aplicaciones nativas ni funcionamiento sin conexión. |

## Requisitos no funcionales

| ID | Propiedad | Criterio de aceptación |
|---|---|---|
| RNF-01 | Integridad | No se confirman ocupaciones solapadas de una unidad reservable ni se duplican reservas o consumos por reintentos. |
| RNF-02 | Aislamiento | Los accesos respetan titularidad y permisos municipales; los convenios habilitan exclusivamente sus capacidades. |
| RNF-03 | Privacidad | Cada tratamiento tiene finalidad, base jurídica, datos, conservación y accesos definidos. No se asignan plazos legales por defecto; los datos bloqueados quedan fuera de consultas, exportaciones y procesamiento ordinarios. Los procedimientos de derechos distinguen su alcance técnico de la resolución administrativa. |
| RNF-04 | Accesibilidad | Los flujos de usuario y administración cumplen WCAG 2.1 AA mediante comprobaciones automáticas y manuales. |
| RNF-05 | Adaptabilidad | Las funciones están disponibles en móvil, tableta y escritorio, sin acciones exclusivas de un tamaño de pantalla. |
| RNF-06 | Modularidad | Los módulos respetan las responsabilidades e interfaces definidas en la arquitectura. |
| RNF-07 | Interoperabilidad | Las interfaces y formatos abiertos disponen de esquemas y ejemplos validables con herramientas independientes. |
| RNF-08 | Replicabilidad | Una instancia independiente utiliza los mismos artefactos y migraciones mediante configuración propia. |
| RNF-09 | Escalabilidad | Las pruebas registran capacidad, latencia y errores al incrementar municipios, unidades reservables y carga. |
| RNF-10 | Recuperación | Una restauración documentada cumple los objetivos RTO y RPO del despliegue, mantiene la integridad y no habilita datos previamente suprimidos o restringidos. |
| RNF-11 | Trazabilidad | Los cambios de reservas y operaciones administrativas conservan autor, instante, motivo cuando corresponda y resultado, sin secretos. |
| RNF-12 | Licencia libre | El código utiliza AGPL-3.0-only, con dependencias y atribuciones compatibles y acceso al código fuente correspondiente cuando lo exige la licencia. |
| RNF-13 | Rendimiento | El sistema cumple los umbrales del [escenario de aceptación](06_decisiones_y_validacion.md#escenario-de-rendimiento). |
| RNF-14 | Operabilidad | Los procedimientos permiten instalar, migrar, verificar, restaurar y revertir despliegues. |
| RNF-15 | Localización | Los flujos, errores y avisos están disponibles en gallego y castellano, con formatos de fecha coherentes. La interfaz utiliza la preferencia explícita del usuario; sin ella, detecta un idioma admitido del navegador y utiliza gallego como alternativa. |

Las obligaciones de la convocatoria se recogen en las [bases oficiales, §1.1, §1.2 y §8](https://www.agasol.gal/wp-content/uploads/2026/10/Bases_I_Certame_GOBTEC_2026_GL_v3.pdf) y en la [descripción del reto](https://www.agasol.gal/i-certame-gobtec/#reto). Las ampliaciones valorables del §1.3 no son requisitos mínimos del certamen.

Las familias, condiciones y límites de conservación se definen en el [modelo de dominio](02_modelo_dominio.md#conservación-y-derechos); los permisos y las descargas, en [identidad y colaboración](07_identidad_y_colaboracion.md#permisos-de-privacidad). Cada responsable aprueba las condiciones aplicables a sus datos, aunque varios municipios compartan una instancia.
