import type { Locale, NoticeKind } from "./notices";

// What the software itself does, stated once for every instance. The responsible entity,
// its purposes and its contact come from the municipality's published text, never from here.
export const baseText: Record<NoticeKind, Record<Locale, readonly string[]>> = {
  privacy: {
    es: [
      "Datos de la cuenta: nombre, correo electrónico y contraseña. La contraseña se guarda protegida y nunca en claro.",
      "Reservas: espacio, horario, estado, condiciones y normas aceptadas, y los avisos asociados.",
      "Seguridad: registro de inicios y cierres de sesión, cambios del segundo factor y accesos rechazados, sin contraseñas ni códigos.",
      "Una cuenta sirve para todos los municipios de esta instancia; los datos y permisos de cada municipio permanecen separados.",
      "La aplicación no incluye analítica, publicidad ni cookies de terceros y no carga recursos de otros sitios al mostrarse.",
      "Desde «Mi cuenta» puedes descargar tus datos, cambiar tu nombre y tu correo y solicitar la baja. Para otros derechos, usa el contacto del responsable.",
    ],
    gl: [
      "Datos da conta: nome, correo electrónico e contrasinal. O contrasinal gárdase protexido e nunca en claro.",
      "Reservas: espazo, horario, estado, condicións e normas aceptadas, e os avisos asociados.",
      "Seguridade: rexistro de inicios e peches de sesión, cambios do segundo factor e accesos rexeitados, sen contrasinais nin códigos.",
      "Unha conta serve para todos os municipios desta instancia; os datos e permisos de cada municipio permanecen separados.",
      "A aplicación non inclúe analítica, publicidade nin cookies de terceiros e non carga recursos doutros sitios ao amosarse.",
      "Desde «A miña conta» podes descargar os teus datos, cambiar o teu nome e o teu correo e solicitar a baixa. Para outros dereitos, usa o contacto do responsable.",
    ],
  },
  legal: {
    es: [
      "Este servicio es una instalación de Quenda, software libre con licencia AGPL-3.0-only. Su código fuente está disponible para quien lo use a través de la red, en el enlace «Código fuente» del pie de página.",
    ],
    gl: [
      "Este servizo é unha instalación de Quenda, software libre con licenza AGPL-3.0-only. O seu código fonte está dispoñible para quen o use a través da rede, na ligazón «Código fonte» do pé de páxina.",
    ],
  },
  accessibility: {
    es: [
      "La aplicación se diseña para cumplir las pautas WCAG 2.1 nivel AA. Cada versión pasa pruebas automáticas de navegador en tamaños de escritorio, tableta y móvil, en modo claro y oscuro, que aplican las reglas WCAG 2.0 y 2.1 de nivel A y AA y usan la aplicación a través de los nombres accesibles de sus controles.",
      "Las pruebas automáticas no cubren todos los criterios. La revisión manual con lector de pantalla, solo teclado y ampliación forma parte de la evaluación de la entidad responsable.",
      "El estado de conformidad que se declara abajo es el que ha publicado la entidad responsable tras su evaluación. Si no aparece, la evaluación aún no se ha completado.",
    ],
    gl: [
      "A aplicación deséñase para cumprir as pautas WCAG 2.1 nivel AA. Cada versión pasa probas automáticas de navegador en tamaños de escritorio, tableta e móbil, en modo claro e escuro, que aplican as regras WCAG 2.0 e 2.1 de nivel A e AA e usan a aplicación a través dos nomes accesibles dos seus controis.",
      "As probas automáticas non cubren todos os criterios. A revisión manual con lector de pantalla, só teclado e ampliación forma parte da avaliación da entidade responsable.",
      "O estado de conformidade que se declara abaixo é o que publicou a entidade responsable tras a súa avaliación. Se non aparece, a avaliación aínda non se completou.",
    ],
  },
};
