/**
 * Everything the application writes to the browser. The privacy page is generated from this list,
 * and a test fails when the code uses a key that is not described here.
 */
export interface StorageEntry {
  key: string;
  store: "local" | "session";
  purpose: [es: string, gl: string];
  duration: [es: string, gl: string];
}
export const storageEntries: readonly StorageEntry[] = [
  {
    key: "quenda.municipality",
    store: "local",
    purpose: [
      "Municipio favorito de este navegador. No se asocia a la cuenta ni concede permisos.",
      "Municipio favorito deste navegador. Non se asocia á conta nin concede permisos.",
    ],
    duration: [
      "Hasta que borres los datos del sitio",
      "Ata que borres os datos do sitio",
    ],
  },
  {
    key: "quenda.preferences",
    store: "local",
    purpose: [
      "Idioma y tema elegidos por quien no ha iniciado sesión.",
      "Idioma e tema escollidos por quen non iniciou sesión.",
    ],
    duration: [
      "Hasta que borres los datos del sitio",
      "Ata que borres os datos do sitio",
    ],
  },
  {
    key: "quenda.staff-entry",
    store: "session",
    purpose: [
      "Destino de «Gestión» durante un minuto, para no repetir consultas.",
      "Destino de «Xestión» durante un minuto, para non repetir consultas.",
    ],
    duration: ["Hasta cerrar la pestaña", "Ata pechar a lapela"],
  },
  {
    key: "quenda.reservation-command",
    store: "session",
    purpose: [
      "Marca de una operación de reserva sin confirmar, para comprobarla sin repetirla.",
      "Marca dunha operación de reserva sen confirmar, para comprobala sen repetila.",
    ],
    duration: [
      "Hasta confirmar la operación o cerrar sesión",
      "Ata confirmar a operación ou pechar sesión",
    ],
  },
  {
    key: "quenda.privacy-uncertain",
    store: "session",
    purpose: [
      "Marca de una actuación de privacidad sin confirmar. No guarda su contenido.",
      "Marca dunha actuación de privacidade sen confirmar. Non garda o seu contido.",
    ],
    duration: [
      "Hasta confirmar la comprobación o cerrar la pestaña",
      "Ata confirmar a comprobación ou pechar a lapela",
    ],
  },
  {
    key: "quenda.platform-uncertain",
    store: "session",
    purpose: [
      "Marca de una operación de plataforma sin confirmar. No guarda su contenido.",
      "Marca dunha operación de plataforma sen confirmar. Non garda o seu contido.",
    ],
    duration: [
      "Hasta confirmar la comprobación o cerrar la pestaña",
      "Ata confirmar a comprobación ou pechar a lapela",
    ],
  },
  {
    key: "quenda.municipal-uncertain",
    store: "session",
    purpose: [
      "Marca de un cambio municipal sin confirmar, para comprobarlo sin repetirlo. No guarda su contenido.",
      "Marca dun cambio municipal sen confirmar, para comprobalo sen repetilo. Non garda o seu contido.",
    ],
    duration: [
      "Hasta confirmar la comprobación o cerrar la pestaña",
      "Ata confirmar a comprobación ou pechar a lapela",
    ],
  },
  {
    key: "quenda.chunk-reload",
    store: "session",
    purpose: [
      "Marca de que la aplicación se recargó una vez tras publicarse una versión nueva, para no recargar en bucle.",
      "Marca de que a aplicación se recargou unha vez tras publicarse unha versión nova, para non recargar en bucle.",
    ],
    duration: ["Hasta cerrar la pestaña", "Ata pechar a lapela"],
  },
];
