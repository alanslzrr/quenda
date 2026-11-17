# Quenda: especificación técnica

Quenda gestiona la consulta y reserva de instalaciones deportivas municipales. El servicio compartido utiliza una cuenta global por instancia y mantiene aislada la actividad de cada municipio. Los convenios habilitan comprobaciones de elegibilidad, cuotas conjuntas e informes agregados con permisos específicos.

## Índice

| Documento | Contenido |
|---|---|
| [01 Requisitos](01_requisitos.md) | Alcance, actores y requisitos funcionales y no funcionales. |
| [02 Modelo de dominio](02_modelo_dominio.md) | Entidades, invariantes, estados y configuración municipal. |
| [03 Procesos y secuencias](03_procesos_y_secuencias.md) | Registro, administración, reservas, avisos, indicadores y conservación. |
| [04 Arquitectura](04_arquitectura.md) | Componentes, decisiones técnicas y despliegue. |
| [05 Seguridad y cumplimiento](05_seguridad_y_cumplimiento.md) | Autorización, aislamiento, privacidad y accesibilidad. |
| [06 Validación](06_decisiones_y_validacion.md) | Pruebas de aceptación, rendimiento y requisitos de implantación. |
| [07 Identidad y colaboración](07_identidad_y_colaboracion.md) | Cuenta global, convenios, acreditaciones, cuotas e informes. |
| [08 Casos de uso](08_casos_de_uso.md) | Actores, objetivos, flujos, excepciones y resultados de las interacciones. |
| [09 Navegación](09_navegacion.md) | Mapa de navegación, recorrido de reserva, contexto entre pasos y municipio favorito. |
| [10 Referencia de la API](10_api.md) | Rutas HTTP por área, permisos exigidos, respuestas y límites. |
| [11 Desarrollo y pruebas](11_desarrollo.md) | Entorno local, aplicación web, demostración y comprobaciones. |
| [12 Despliegue y operación](12_operacion.md) | Imágenes, despliegue de referencia, workers, auditoría, métricas, copias y recuperación. |
| [13 Despliegue en la nube](13_despliegue_nube.md) | Infraestructura en OCI, AWS, Azure y GCP, validación local con emuladores, publicación y demostración. |

## Terminología

| Término | Definición |
|---|---|
| Usuario | Persona que utiliza el sistema. Una cuenta permite reservar en los municipios de su instancia. |
| Administrador municipal | Usuario autorizado para configurar el municipio y asignar permisos a su personal. |
| Gestor municipal | Usuario con permisos delegados sobre operaciones o unidades reservables del municipio. |
| Operador de plataforma | Usuario autorizado para dar de alta municipios y operar la instancia. |
| Municipio | Ámbito de administración, configuración y datos municipales. |
| Instalación | Centro deportivo que contiene una o varias unidades reservables. |
| Unidad reservable | Espacio completo que se reserva de forma exclusiva, como una pista, sala o pabellón. |
| Reserva | Asignación de una unidad reservable a un usuario durante un intervalo. |
| Instancia | Despliegue del sistema con base de datos, cuentas, configuración y secretos propios. |

Los identificadores `RF`, `RNF`, `RN`, `CU`, `ADR`, `T` y `PD` corresponden a requisitos funcionales, requisitos no funcionales, reglas de negocio, casos de uso, decisiones arquitectónicas, pruebas y decisiones pendientes.

## Licencia

El código de Quenda se distribuye bajo [AGPL-3.0-only](https://spdx.org/licenses/AGPL-3.0-only.html). El texto íntegro está en [LICENSE](../LICENSE). Los despliegues sujetos a sus obligaciones facilitan el código fuente correspondiente; en particular, las versiones modificadas accesibles por red deben ofrecerlo a los usuarios que interactúan con ellas. La distribución conserva los avisos y atribuciones aplicables.
