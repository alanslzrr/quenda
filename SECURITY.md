# Política de seguridad

Quenda gestiona cuentas, reservas y datos personales de la ciudadanía en nombre de administraciones públicas. Agradecemos cualquier aviso que ayude a protegerlos y lo tratamos con prioridad y confidencialidad.

## Versiones con soporte

El proyecto todavía no publica versiones estables. Las correcciones de seguridad se aplican sobre la rama `main`; cada instalación debe actualizarse a la revisión que contenga la corrección.

| Versión | Soporte |
|---|---|
| `main` | Sí |
| Revisiones anteriores | No |

## Cómo comunicar una vulnerabilidad

**No abras un issue, una discusión ni una pull request pública** para describir una vulnerabilidad.

Utiliza el aviso privado de vulnerabilidades de GitHub:

1. Abre la pestaña **Security** del repositorio.
2. Selecciona **Report a vulnerability**.
3. Completa el formulario.

El aviso solo es visible para quienes mantienen el proyecto. Puedes escribirlo en castellano, gallego o inglés. Incluye, en la medida de lo posible:

- el componente afectado (API, aplicación web, worker, migraciones, imágenes o composición de referencia) y la revisión o fecha del código;
- la descripción del problema y su impacto: qué datos o permisos quedan expuestos y a quién;
- los pasos mínimos para reproducirlo, preferiblemente sobre la [demostración local](test/demo/README.md) o un entorno propio;
- cualquier mitigación conocida.

No incluyas datos personales reales, credenciales ni secretos de una instalación en el aviso.

## Qué puedes esperar

- Confirmaremos la recepción y haremos una primera valoración en un plazo de cinco días hábiles.
- Te mantendremos informado del análisis y de la corrección, y acordaremos contigo la fecha de divulgación. Como referencia, la divulgación coordinada se produce cuando hay una corrección disponible o, como máximo, a los 90 días del aviso.
- Si lo deseas, reconoceremos tu aportación en el aviso de seguridad publicado.

## Alcance

Están dentro del alcance el código y la configuración de este repositorio: API, aplicación web, workers, migraciones de base de datos, imágenes OCI y composición de referencia.

Quedan fuera:

- Las instalaciones operadas por terceros. Cada ayuntamiento o entidad es responsable de su despliegue; comunica los problemas de una instalación concreta a quien la opera.
- Las vulnerabilidades ya publicadas de dependencias que no resulten explotables en Quenda. Si lo son, avísanos indicando cómo.
- Los ataques de denegación de servicio, la ingeniería social y el acceso físico.

## Investigación de buena fe

Al investigar, utiliza exclusivamente entornos propios o la demostración local. No accedas, modifiques ni conserves datos de otras personas, no degrades el servicio de una instalación en funcionamiento y detén la prueba en cuanto demuestres el problema.

## Información relacionada

Las medidas de seguridad y privacidad del diseño se describen en [Seguridad y cumplimiento](docs/05_seguridad_y_cumplimiento.md).
