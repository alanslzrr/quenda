# Capturas de los casos de uso

Las imágenes de esta carpeta ilustran, paso a paso, los [casos de uso](../08_casos_de_uso.md). Cada caso tiene su carpeta (`cu-01/` … `cu-23/`) y cada paso un archivo `NN-paso.webp`, numerado en el orden del flujo. En cada captura, el elemento sobre el que actúa el paso aparece recuadrado en naranja.

No se editan a mano: las genera un recorrido automatizado con Playwright sobre una instalación local efímera.

## Regenerarlas

Requisitos: dependencias instaladas (`pnpm install` en la raíz y en `web/`), navegadores de Playwright y `PG_BIN` apuntando a PostgreSQL 17.11, igual que las pruebas de integración.

```sh
PG_BIN=/ruta/a/postgresql@17/bin pnpm docs:capture
```

El comando:

1. Crea una base de datos efímera y la siembra con el mismo conjunto de datos que la demostración pública (`test/demo/cloud.ts`): Valdeira y Ribasanta, personal con todos los roles y unas 3.500 reservas en catorce semanas de historial.
2. Arranca la API en `127.0.0.1:3200` y la web en `127.0.0.1:5175` (se pueden cambiar con `QUENDA_CAPTURE_API_PORT` y `QUENDA_CAPTURE_WEB_PORT`). Los correos se guardan en `.local/capture/mail`; nada sale de la máquina.
3. Recorre los escenarios de `web/docs-capture/` en orden, en escritorio (1280 × 800), tema claro y castellano, y sustituye por completo la carpeta de cada caso de uso que recorre.

Para regenerar solo un caso, indica su escenario desde `web/`: `PG_BIN=/ruta/a/postgresql@17/bin pnpm exec playwright test --config playwright.docs.config.ts docs-capture/cu-09-sesion.spec.ts`. Los escenarios comparten la base efímera de una ejecución completa, así que un caso regenerado por separado puede mostrar otros datos de contexto (por ejemplo, menos municipios) que en la ejecución completa.

Nunca se ejecuta contra la demostración pública: varios escenarios dan de baja cuentas, suspenden identidades o aplican políticas de conservación, y esos cambios no se pueden deshacer.

## Independencia de la hora y del día

El sembrado es relativo a la fecha actual, así que las fechas visibles cambian de una ejecución a otra, pero el contenido de cada captura no depende de la hora ni del día en que se genera:

- La API y PostgreSQL usan su reloj real (`now()`), que no se puede fijar sin alterar el servidor. Por eso ningún escenario depende de lo que quede del día actual: las vistas de «hoy» que cambian según la hora usan un día futuro elegido por el escenario (la agenda, los horarios que se reservan, los bloqueos).
- La página de un espacio se abre por defecto en «hoy». En CU-01, el reloj del navegador se fija en las 09:00 del día siguiente (hora de Madrid) con `page.clock`, de modo que ese «hoy» siempre tiene el día completo de horarios libres. El servidor sigue con su reloj y acepta ese día como cualquier otro día futuro.
- Antes de cada captura se espera a que terminen las peticiones, desaparezcan los indicadores «Cargando…», se carguen fuentes e imágenes y acaben las transiciones. Si una barra fija o la cabecera tapan el elemento señalado, se centra en su zona de desplazamiento.

CU-20 compila el worker (`pnpm build`) y ejecuta `node dist/email-worker.js --once`, el mismo comando que en producción.

`pnpm docs:capture` no forma parte de `pnpm validate` ni del CI. Conviene regenerar las capturas cuando un cambio de interfaz afecte a una pantalla documentada.
