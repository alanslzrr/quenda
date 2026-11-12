// Standard wording of the legal pages, true of every Quenda instance. The entity's
// own published text replaces a section when it exists; sections that only the
// entity can write (who it is, its tax id, its conformance status) are omitted
// until it publishes them, never filled with placeholders.

export type Text = readonly [es: string, gl: string];

export const privacyText = {
  data: [
    [
      "Datos de la cuenta: nombre, correo electrónico y contraseña. La contraseña se guarda protegida y nunca en claro.",
      "Datos da conta: nome, correo electrónico e contrasinal. O contrasinal gárdase protexido e nunca en claro.",
    ],
    [
      "Reservas: espacio, horario, estado, condiciones y normas aceptadas, y los avisos asociados.",
      "Reservas: espazo, horario, estado, condicións e normas aceptadas, e os avisos asociados.",
    ],
    [
      "Llegada a la instalación: si el personal escanea el código QR de tu reserva, se guarda la hora de llegada y quién la registró. La ves en tu reserva y en la descarga de tus datos.",
      "Chegada á instalación: se o persoal escanea o código QR da túa reserva, gárdase a hora de chegada e quen a rexistrou. Vela na túa reserva e na descarga dos teus datos.",
    ],
    [
      "Suscripción de calendario, solo si la activas: una dirección secreta permite a tu aplicación de calendario leer tus próximas reservas confirmadas. Se guarda la fecha de alta y un resumen de la dirección, nunca la dirección. La retiras desde «Mis reservas» y se retira sola al dar de baja la cuenta.",
      "Subscrición de calendario, só se a activas: un enderezo secreto permite á túa aplicación de calendario ler as túas próximas reservas confirmadas. Gárdase a data de alta e un resumo do enderezo, nunca o enderezo. Retírala desde «As miñas reservas» e retírase soa ao dar de baixa a conta.",
    ],
    [
      "Recomendaciones de horario: al abrir «Mis reservas» se calculan, con tus reservas confirmadas de los últimos seis meses, los horarios que repites y su próximo hueco libre. Solo las ves tú, no se guarda ningún perfil ni se usan sistemas de inteligencia artificial, y puedes desactivarlas en «Privacidad y baja de cuenta».",
      "Recomendacións de horario: ao abrir «As miñas reservas» calcúlanse, coas túas reservas confirmadas dos últimos seis meses, os horarios que repites e o seu próximo oco libre. Só as ves ti, non se garda ningún perfil nin se usan sistemas de intelixencia artificial, e podes desactivalas en «Privacidade e baixa de conta».",
    ],
    [
      "Seguridad: registro de inicios y cierres de sesión, cambios de la verificación en dos pasos y accesos rechazados, sin contraseñas ni códigos.",
      "Seguridade: rexistro de inicios e peches de sesión, cambios da verificación en dous pasos e accesos rexeitados, sen contrasinais nin códigos.",
    ],
  ] as readonly Text[],
  purposes: [
    "Gestionar tu cuenta y tus reservas, enviarte los avisos relacionados con ellas, permitir al personal autorizado comprobar las reservas de las instalaciones que gestiona y mantener la seguridad del servicio. Una misma cuenta sirve para todos los municipios de este servicio, y los datos de cada municipio se mantienen separados.",
    "Xestionar a túa conta e as túas reservas, enviarche os avisos relacionados con elas, permitir ao persoal autorizado comprobar as reservas das instalacións que xestiona e manter a seguridade do servizo. Unha mesma conta serve para todos os municipios deste servizo, e os datos de cada municipio mantéñense separados.",
  ] as Text,
  legalBasis: [
    "El tratamiento es necesario para prestar el servicio de reserva que solicitas (artículo 6.1.b del Reglamento General de Protección de Datos) y para el ejercicio de las competencias municipales sobre instalaciones deportivas (artículo 6.1.e).",
    "O tratamento é necesario para prestar o servizo de reserva que solicitas (artigo 6.1.b do Regulamento xeral de protección de datos) e para o exercicio das competencias municipais sobre instalacións deportivas (artigo 6.1.e).",
  ] as Text,
  recipients: [
    "No se ceden datos a terceros, salvo obligación legal. El personal municipal autorizado solo accede a las reservas de las instalaciones que gestiona.",
    "Non se ceden datos a terceiros, agás obriga legal. O persoal municipal autorizado só accede ás reservas das instalacións que xestiona.",
  ] as Text,
  retention: [
    "Los datos se conservan mientras mantengas la cuenta y, después, durante los plazos que establezcan la normativa aplicable y la política de conservación de la entidad responsable.",
    "Os datos consérvanse mentres manteñas a conta e, despois, durante os prazos que establezan a normativa aplicable e a política de conservación da entidade responsable.",
  ] as Text,
  rights: [
    "Puedes ejercer los derechos de acceso, rectificación, supresión, oposición, limitación del tratamiento y portabilidad. Desde «Mi cuenta» puedes descargar tus datos, cambiar tu nombre y tu correo y solicitar la baja; para el resto, dirígete a la entidad responsable.",
    "Podes exercer os dereitos de acceso, rectificación, supresión, oposición, limitación do tratamento e portabilidade. Desde «A miña conta» podes descargar os teus datos, cambiar o teu nome e o teu correo e solicitar a baixa; para o resto, diríxete á entidade responsable.",
  ] as Text,
  complaint: [
    "Si consideras que el tratamiento no se ajusta a la normativa, puedes presentar una reclamación ante la Agencia Española de Protección de Datos (www.aepd.es).",
    "Se consideras que o tratamento non se axusta á normativa, podes presentar unha reclamación ante a Axencia Española de Protección de Datos (www.aepd.es).",
  ] as Text,
  storage: [
    "El servicio no incluye analítica, publicidad ni cookies de terceros y no carga recursos de otros sitios. Solo usa el almacenamiento necesario para funcionar: la sesión se mantiene con una cookie propia, segura y no accesible desde scripts, y además se guarda lo siguiente en tu navegador.",
    "O servizo non inclúe analítica, publicidade nin cookies de terceiros e non carga recursos doutros sitios. Só usa o almacenamento necesario para funcionar: a sesión mantense cunha cookie propia, segura e non accesible desde scripts, e ademais gárdase o seguinte no teu navegador.",
  ] as Text,
};

export const legalText = {
  purpose: [
    "Este sitio permite consultar las instalaciones deportivas municipales y su disponibilidad, reservarlas y gestionar las reservas: cambiarlas, cancelarlas y recibir sus avisos.",
    "Este sitio permite consultar as instalacións deportivas municipais e a súa dispoñibilidade, reservalas e xestionar as reservas: cambialas, cancelalas e recibir os seus avisos.",
  ] as Text,
  terms: [
    "Usar el servicio implica aceptar este aviso legal. Cada reserva está sujeta a las normas de uso de la instalación y a las condiciones de reserva y cancelación que se muestran antes de confirmarla. La cuenta es personal: custodia tu contraseña y haz un uso adecuado de las instalaciones reservadas.",
    "Usar o servizo implica aceptar este aviso legal. Cada reserva está suxeita ás normas de uso da instalación e ás condicións de reserva e cancelación que se amosan antes de confirmala. A conta é persoal: custodia o teu contrasinal e fai un uso axeitado das instalacións reservadas.",
  ] as Text,
  liability: [
    "La disponibilidad que se muestra es informativa hasta que confirmas la reserva. La entidad responsable puede modificar o cancelar una reserva por causas justificadas, como el mantenimiento de la instalación, y te lo comunicará a través de los avisos del servicio.",
    "A dispoñibilidade que se amosa é informativa ata que confirmas a reserva. A entidade responsable pode modificar ou cancelar unha reserva por causas xustificadas, como o mantemento da instalación, e comunicarache a través dos avisos do servizo.",
  ] as Text,
  property: [
    "Los textos, imágenes y signos distintivos de la entidad responsable le pertenecen. La aplicación es Quenda, software libre distribuido con la licencia AGPL-3.0-only.",
    "Os textos, imaxes e signos distintivos da entidade responsable pertencéntelle. A aplicación é Quenda, software libre distribuído coa licenza AGPL-3.0-only.",
  ] as Text,
  source: [
    "Descargar el código fuente de la versión en funcionamiento",
    "Descargar o código fonte da versión en funcionamento",
  ] as Text,
  law: [
    "Este aviso legal se rige por la legislación española.",
    "Este aviso legal réxese pola lexislación española.",
  ] as Text,
};

export const accessibilityText = {
  commitment: (owner: string | undefined): Text => [
    `${owner ?? "La entidad responsable de este servicio"} se compromete a hacer accesible su sitio web de conformidad con el Real Decreto 1112/2018, de 7 de septiembre, sobre accesibilidad de los sitios web y aplicaciones para dispositivos móviles del sector público. Esta declaración se aplica a este servicio de reserva de instalaciones deportivas.`,
    `${owner ?? "A entidade responsable deste servizo"} comprométese a facer accesible o seu sitio web de conformidade co Real decreto 1112/2018, do 7 de setembro, sobre accesibilidade dos sitios web e aplicacións para dispositivos móbiles do sector público. Esta declaración aplícase a este servizo de reserva de instalacións deportivas.`,
  ],
  design: [
    [
      "El servicio se diseña para cumplir las pautas WCAG 2.1 de nivel AA y la norma EN 301 549. Cada versión pasa pruebas automáticas en escritorio, tableta y móvil, en modo claro y oscuro, que comprueban las pautas WCAG 2.0 y 2.1 de niveles A y AA.",
      "O servizo deséñase para cumprir as pautas WCAG 2.1 de nivel AA e a norma EN 301 549. Cada versión pasa probas automáticas en escritorio, tableta e móbil, en modo claro e escuro, que comproban as pautas WCAG 2.0 e 2.1 de niveis A e AA.",
    ],
    [
      "Se puede usar con teclado, lector de pantalla y ampliación del texto, y respeta la preferencia de movimiento reducido y los colores forzados del sistema.",
      "Pódese usar con teclado, lector de pantalla e ampliación do texto, e respecta a preferencia de movemento reducido e as cores forzadas do sistema.",
    ],
  ] as readonly Text[],
  feedback: [
    "Puedes comunicar problemas de accesibilidad, solicitar información en un formato accesible o presentar una queja a través de los canales de atención de la entidad responsable.",
    "Podes comunicar problemas de accesibilidade, solicitar información nun formato accesible ou presentar unha queixa a través das canles de atención da entidade responsable.",
  ] as Text,
  enforcement: [
    "Si tu solicitud de información accesible o tu queja ha sido desestimada, no estás de acuerdo con la decisión o no has recibido respuesta en el plazo de veinte días hábiles, puedes presentar una reclamación ante la entidad responsable conforme al artículo 13 del Real Decreto 1112/2018.",
    "Se a túa solicitude de información accesible ou a túa queixa foi desestimada, non estás de acordo coa decisión ou non recibiches resposta no prazo de vinte días hábiles, podes presentar unha reclamación ante a entidade responsable conforme ao artigo 13 do Real decreto 1112/2018.",
  ] as Text,
};
