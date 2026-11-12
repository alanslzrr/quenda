# Guía de contribución

Gracias por tu interés en Quenda. Esta guía resume cómo proponer cambios. La preparación del entorno y las comprobaciones están en [Desarrollo y pruebas](docs/11_desarrollo.md).

## Antes de empezar

- **Vulnerabilidades:** no las publiques en issues; sigue la [política de seguridad](SECURITY.md).
- **Errores y propuestas:** abre un issue que describa el comportamiento observado y el esperado, o el problema que resuelve la propuesta. Para cambios amplios, acuerda el enfoque en el issue antes de implementarlo.
- **Especificación:** los requisitos (`RF`, `RNF`), las reglas de negocio y las decisiones de arquitectura están en [docs](docs/README.md). Un cambio de comportamiento debe ser coherente con ellos o actualizarlos.

## Cómo trabajar

1. Crea una rama desde `main` con un nombre descriptivo en minúsculas y separado por guiones, por ejemplo `cancel-reservation-after-relocation`.
2. Mantén cada commit centrado en una sola responsabilidad.
3. Ejecuta la validación completa antes de abrir la pull request:

   ```sh
   PG_BIN=/ruta/a/postgresql-17.11/bin pnpm validate
   ```

4. Abre la pull request contra `main` explicando el cambio, su motivación y cómo se ha verificado.

## Convenciones

- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/es/v1.0.0/) con ámbito obligatorio, en inglés: `tipo(ámbito): descripción`. Tipos admitidos: `feat`, `fix`, `refactor`, `perf`, `test`, `build`, `ci`, `docs` y `chore`. Por ejemplo, `fix(reservations): reject cancellation after the accepted deadline`.
- **Código:** TypeScript estricto, con formato y lint de Biome (`pnpm format`). Cada módulo del backend expone su interfaz por `src/modules/<módulo>/index.ts`; no importes archivos privados de otro módulo.
- **Base de datos:** las migraciones aplicadas son inmutables. Añade siempre un archivo nuevo en `db/migrations` con el número siguiente y conserva las garantías de RLS y de permisos de cada rol.
- **Interfaz:** todo texto visible debe estar en gallego y castellano. Las pantallas nuevas deben funcionar con teclado y lector de pantalla e incluir un análisis axe en las pruebas de navegador.
- **Pruebas:** acompaña cada cambio de comportamiento con pruebas en el nivel adecuado: unitarias, HTTP, de integración con PostgreSQL o de navegador.
- **Documentación:** actualiza la documentación afectada, incluidos los requisitos, las pruebas de aceptación y la [referencia de la API](docs/10_api.md).

## Licencia de las aportaciones

Quenda se distribuye bajo [AGPL-3.0-only](LICENSE). Al enviar una aportación, aceptas que se distribuya bajo esa misma licencia y declaras que tienes derecho a hacerlo.
