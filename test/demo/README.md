# Acceso a la demostración local

La API de demostración escucha exclusivamente en `127.0.0.1:3100`; Vite se configura en `127.0.0.1:5174` con `QUENDA_API=http://127.0.0.1:3100`. El servidor requiere `PG_BIN` apuntando a PostgreSQL 17.11, igual que las pruebas de integración.

Cada arranque de `pnpm demo:local` crea una base efímera nueva: no reinicies una demostración en uso para recuperar acceso sin avisar de la pérdida de sus datos. La supervivencia del proceso depende del terminal o supervisor que lo lance; este comando no lo convierte en un servicio persistente.

## Cuentas

| Cuenta | Usuario | Contraseña |
| --- | --- | --- |
| Vecina | `lucia.pereira@demo.test` | `Demostracion-quenda-2026` |
| Administración de Valdeira | `administracion@valdeira.demo.test` | `Demostracion-quenda-2026` |

La administración exige además MFA. Desde la raíz del repositorio, ejecuta:

```sh
pnpm demo:code
```

El comando compara la identidad del arranque en marcha con `.local/demo/access.json` y solo entonces muestra un código TOTP de seis dígitos y su vigencia. Si quedan pocos segundos, vuelve a ejecutarlo cuando cambie el intervalo. Abre `http://127.0.0.1:5174/acceso`, introduce usuario y contraseña, y después el código actual. Accede a «Gestión» para administrar Valdeira; «Reservar» y «Mis reservas» son el espacio personal.

El secreto cambia con cada nueva base y **no se imprime en la consola**. El archivo local es privado (modo 0600 dentro de un directorio 0700), está excluido de Git y no debe compartirse. No copies un secreto ni un código de un registro antiguo. El endpoint `/__demo/run` solo existe en este servidor de demostración, devuelve la identidad no secreta del proceso y no autentica ni concede permisos.

Un archivo antiguo, un servidor parado, una identidad distinta, una respuesta inválida o permisos de archivo demasiado abiertos hacen fallar el comando sin generar un código. Si el proceso fue iniciado con una versión anterior que no publica identidad, el comando tampoco puede verificarlo: utiliza su consola de arranque original o acuerda un reinicio de la demo antes de sustituirlo. No desactives MFA ni cambies credenciales de la cuenta para sortear esta comprobación.
