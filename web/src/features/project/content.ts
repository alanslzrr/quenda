// Texts of the project page, in Spanish and Galician. Each entry is [es, gl].
export type Text = readonly [string, string];

export type Audience = "citizen" | "municipal" | "platform" | "privacy";

export interface UseCase {
  id: string;
  audience: Audience;
  title: Text;
  answer: Text;
  actor: Text;
}

export const audiences: Record<Audience, Text> = {
  citizen: ["Ciudadanía", "Cidadanía"],
  municipal: ["Ayuntamiento", "Concello"],
  platform: ["Plataforma", "Plataforma"],
  privacy: ["Privacidad y operación", "Privacidade e operación"],
};

export const useCases: UseCase[] = [
  {
    id: "consultar",
    audience: "citizen",
    title: [
      "Consultar instalaciones y disponibilidad",
      "Consultar instalacións e dispoñibilidade",
    ],
    answer: [
      "Cualquier persona, con o sin cuenta, puede elegir municipio, instalación y espacio y consultar los horarios libres de un día concreto. También puede buscar por día y hora en todas las instalaciones del municipio. La consulta no genera ninguna reserva ni registra datos de la persona.",
      "Calquera persoa, con ou sen conta, pode escoller concello, instalación e espazo e consultar os horarios libres dun día concreto. Tamén pode buscar por día e hora en todas as instalacións do concello. A consulta non xera ningunha reserva nin rexistra datos da persoa.",
    ],
    actor: [
      "Perfil: cualquier persona, con o sin sesión iniciada.",
      "Perfil: calquera persoa, con ou sen sesión iniciada.",
    ],
  },
  {
    id: "reservar",
    audience: "citizen",
    title: ["Crear una reserva", "Crear unha reserva"],
    answer: [
      "Antes de confirmar se muestran el espacio, el horario, las normas de uso y las condiciones de cancelación, que deben aceptarse de forma expresa. Una vez confirmada, la reserva dispone de un código QR de acceso y se notifica por correo electrónico.",
      "Antes de confirmar móstranse o espazo, o horario, as normas de uso e as condicións de cancelación, que deben aceptarse de forma expresa. Unha vez confirmada, a reserva dispón dun código QR de acceso e notifícase por correo electrónico.",
    ],
    actor: ["Perfil: persona con cuenta.", "Perfil: persoa con conta."],
  },
  {
    id: "modificar",
    audience: "citizen",
    title: [
      "Modificar o cancelar una reserva",
      "Modificar ou cancelar unha reserva",
    ],
    answer: [
      "Dentro del plazo publicado por el ayuntamiento, la reserva puede trasladarse a otro horario o cancelarse desde su ficha. Si otra persona autorizada la ha modificado entretanto, la aplicación lo indica antes de continuar.",
      "Dentro do prazo publicado polo concello, a reserva pode trasladarse a outro horario ou cancelarse desde a súa ficha. Se outra persoa autorizada a modificou mentres tanto, a aplicación indícao antes de continuar.",
    ],
    actor: [
      "Perfil: titular de la reserva o personal municipal autorizado.",
      "Perfil: titular da reserva ou persoal municipal autorizado.",
    ],
  },
  {
    id: "cuenta",
    audience: "citizen",
    title: ["Crear una cuenta", "Crear unha conta"],
    answer: [
      "Una única cuenta permite reservar en todos los municipios de la instalación. El alta requiere verificar la dirección de correo electrónico.",
      "Unha única conta permite reservar en todos os concellos da instalación. A alta require verificar o enderezo de correo electrónico.",
    ],
    actor: ["Perfil: cualquier persona.", "Perfil: calquera persoa."],
  },
  {
    id: "historial",
    audience: "citizen",
    title: [
      "Consultar el historial de reservas",
      "Consultar o historial de reservas",
    ],
    answer: [
      "La sección «Mis reservas» reúne las reservas de todos los municipios, con filtro por municipio. Incluye sugerencias de horario calculadas a partir de las reservas anteriores de la propia persona, que pueden desactivarse.",
      "A sección «As miñas reservas» reúne as reservas de todos os concellos, con filtro por concello. Inclúe suxestións de horario calculadas a partir das reservas anteriores da propia persoa, que se poden desactivar.",
    ],
    actor: [
      "Perfil: titular; personal municipal dentro de su ámbito.",
      "Perfil: titular; persoal municipal dentro do seu ámbito.",
    ],
  },
  {
    id: "sesion",
    audience: "citizen",
    title: ["Iniciar o cerrar sesión", "Iniciar ou pechar sesión"],
    answer: [
      "El acceso se realiza con correo electrónico y contraseña. La verificación en dos pasos es opcional para la ciudadanía y obligatoria para cualquier permiso de gestión.",
      "O acceso realízase con correo electrónico e contrasinal. A verificación en dous pasos é opcional para a cidadanía e obrigatoria para calquera permiso de xestión.",
    ],
    actor: ["Perfil: persona con cuenta.", "Perfil: persoa con conta."],
  },
  {
    id: "avisos",
    audience: "citizen",
    title: ["Recibir y consultar avisos", "Recibir e consultar avisos"],
    answer: [
      "Cada confirmación, modificación o cancelación se comunica por correo electrónico y queda registrada en la sección «Avisos» de la aplicación, enlazada con la reserva correspondiente.",
      "Cada confirmación, modificación ou cancelación comunícase por correo electrónico e queda rexistrada na sección «Avisos» da aplicación, ligada coa reserva correspondente.",
    ],
    actor: ["Perfil: titular de la reserva.", "Perfil: titular da reserva."],
  },
  {
    id: "datos",
    audience: "citizen",
    title: [
      "Actualizar datos personales y correo",
      "Actualizar datos persoais e correo",
    ],
    answer: [
      "El nombre, el idioma y el tema se modifican desde el perfil. El cambio de correo electrónico se autoriza desde la dirección actual y se confirma desde la nueva.",
      "O nome, o idioma e o tema modifícanse desde o perfil. O cambio de correo electrónico autorízase desde o enderezo actual e confírmase desde o novo.",
    ],
    actor: ["Perfil: titular de la cuenta.", "Perfil: titular da conta."],
  },
  {
    id: "baja",
    audience: "citizen",
    title: ["Dar de baja la cuenta", "Dar de baixa a conta"],
    answer: [
      "La baja desactiva la cuenta en todos los municipios. Si existen reservas futuras, la aplicación lo advierte antes de continuar.",
      "A baixa desactiva a conta en todos os concellos. Se existen reservas futuras, a aplicación advírteo antes de continuar.",
    ],
    actor: ["Perfil: titular de la cuenta.", "Perfil: titular da conta."],
  },
  {
    id: "reactivar",
    audience: "citizen",
    title: ["Reactivar una cuenta", "Reactivar unha conta"],
    answer: [
      "Una cuenta dada de baja de forma voluntaria se recupera mediante un enlace de un solo uso enviado al correo electrónico.",
      "Unha conta dada de baixa de forma voluntaria recupérase mediante unha ligazón dun só uso enviada ao correo electrónico.",
    ],
    actor: [
      "Perfil: persona que solicitó la baja.",
      "Perfil: persoa que solicitou a baixa.",
    ],
  },
  {
    id: "copia",
    audience: "citizen",
    title: [
      "Obtener una copia de los datos personales",
      "Obter unha copia dos datos persoais",
    ],
    answer: [
      "Cualquier persona puede descargar en un formato abierto los datos que la aplicación conserva sobre ella, agrupados por categoría.",
      "Calquera persoa pode descargar nun formato aberto os datos que a aplicación conserva sobre ela, agrupados por categoría.",
    ],
    actor: [
      "Perfil: persona interesada o personal autorizado.",
      "Perfil: persoa interesada ou persoal autorizado.",
    ],
  },
  {
    id: "catalogo",
    audience: "municipal",
    title: [
      "Mantener el catálogo y los calendarios",
      "Manter o catálogo e os calendarios",
    ],
    answer: [
      "Las instalaciones y los espacios se preparan como borrador, con fotografías, normas de uso versionadas y horarios semanales con excepciones, y se publican de forma explícita. La retirada de un espacio conserva su historial.",
      "As instalacións e os espazos prepáranse como borrador, con fotografías, normas de uso versionadas e horarios semanais con excepcións, e publícanse de forma explícita. A retirada dun espazo conserva o seu historial.",
    ],
    actor: [
      "Perfil: administración o gestión municipal autorizada.",
      "Perfil: administración ou xestión municipal autorizada.",
    ],
  },
  {
    id: "uso",
    audience: "municipal",
    title: [
      "Consultar el uso y exportar datos",
      "Consultar o uso e exportar datos",
    ],
    answer: [
      "La aplicación presenta la ocupación, las horas reservadas, las cancelaciones, las llegadas registradas y la demanda por día y hora, comparadas con el periodo anterior. Las exportaciones en CSV o JSON excluyen nombres y correos electrónicos.",
      "A aplicación presenta a ocupación, as horas reservadas, as cancelacións, as chegadas rexistradas e a demanda por día e hora, comparadas co período anterior. As exportacións en CSV ou JSON exclúen nomes e correos electrónicos.",
    ],
    actor: [
      "Perfil: gestión municipal autorizada.",
      "Perfil: xestión municipal autorizada.",
    ],
  },
  {
    id: "convenio",
    audience: "municipal",
    title: [
      "Gestionar un convenio intermunicipal",
      "Xestionar un convenio intermunicipal",
    ],
    answer: [
      "Dos o más municipios pueden acordar el uso compartido de espacios con un alcance y una vigencia determinados. Cada municipio aprueba la versión del convenio y su activación queda registrada.",
      "Dous ou máis concellos poden acordar o uso compartido de espazos cun alcance e unha vixencia determinados. Cada concello aproba a versión do convenio e a súa activación queda rexistrada.",
    ],
    actor: [
      "Perfil: administración de los municipios participantes.",
      "Perfil: administración dos concellos participantes.",
    ],
  },
  {
    id: "permisos",
    audience: "municipal",
    title: [
      "Delegar permisos y relevar responsables",
      "Delegar permisos e relevar responsables",
    ],
    answer: [
      "Las invitaciones se dirigen a una dirección de correo electrónico e incluyen permisos por operación y por espacio, con caducidad opcional y retirada inmediata. La aplicación impide que un municipio quede sin persona responsable.",
      "As invitacións diríxense a un enderezo de correo electrónico e inclúen permisos por operación e por espazo, con caducidade opcional e retirada inmediata. A aplicación impide que un concello quede sen persoa responsable.",
    ],
    actor: [
      "Perfil: administración municipal u operación de la plataforma.",
      "Perfil: administración municipal ou operación da plataforma.",
    ],
  },
  {
    id: "acreditacion",
    audience: "municipal",
    title: [
      "Gestionar una acreditación de uso",
      "Xestionar unha acreditación de uso",
    ],
    answer: [
      "Un convenio puede exigir una acreditación para reservar determinados espacios. El municipio emisor la registra o la revoca, y la aplicación la comprueba al crear cada reserva.",
      "Un convenio pode esixir unha acreditación para reservar determinados espazos. O concello emisor rexístraa ou revógaa, e a aplicación compróbaa ao crear cada reserva.",
    ],
    actor: [
      "Perfil: municipio designado como emisor en el convenio.",
      "Perfil: concello designado como emisor no convenio.",
    ],
  },
  {
    id: "informe",
    audience: "municipal",
    title: ["Consultar un informe conjunto", "Consultar un informe conxunto"],
    answer: [
      "Los municipios de un convenio disponen de informes mensuales agregados. Cada municipio participante los revisa y solo se publican cuando el riesgo de identificar a una persona es aceptable.",
      "Os concellos dun convenio dispoñen de informes mensuais agregados. Cada concello participante revísaos e só se publican cando o risco de identificar a unha persoa é aceptable.",
    ],
    actor: [
      "Perfil: personal con permiso de informes y administraciones revisoras.",
      "Perfil: persoal con permiso de informes e administracións revisoras.",
    ],
  },
  {
    id: "apariencia",
    audience: "municipal",
    title: [
      "Configurar la apariencia pública",
      "Configurar a aparencia pública",
    ],
    answer: [
      "Cada municipio define su nombre visible, su logotipo para fondo claro y oscuro y un tema de color. La aplicación comprueba el contraste de los colores antes de guardarlos.",
      "Cada concello define o seu nome visible, o seu logotipo para fondo claro e escuro e un tema de cor. A aplicación comproba o contraste das cores antes de gardalas.",
    ],
    actor: [
      "Perfil: administración municipal.",
      "Perfil: administración municipal.",
    ],
  },
  {
    id: "municipio",
    audience: "platform",
    title: ["Incorporar un municipio", "Incorporar un concello"],
    answer: [
      "La operación de la plataforma da de alta el municipio con su zona horaria e invita por correo electrónico a su primera persona responsable.",
      "A operación da plataforma dá de alta o concello coa súa zona horaria e invita por correo electrónico á súa primeira persoa responsable.",
    ],
    actor: [
      "Perfil: operación de la plataforma.",
      "Perfil: operación da plataforma.",
    ],
  },
  {
    id: "compromiso",
    audience: "platform",
    title: [
      "Contener un compromiso y recuperar el acceso",
      "Conter un compromiso e recuperar o acceso",
    ],
    answer: [
      "Si una cuenta se ve comprometida, se retiran sus accesos de inmediato y, cuando procede, se suspende la identidad. El servicio se recupera mediante una persona sustituta verificada.",
      "Se unha conta se ve comprometida, retíranse os seus accesos de inmediato e, cando procede, suspéndese a identidade. O servizo recupérase mediante unha persoa substituta verificada.",
    ],
    actor: [
      "Perfil: administración municipal u operación, según el caso.",
      "Perfil: administración municipal ou operación, segundo o caso.",
    ],
  },
  {
    id: "conservacion",
    audience: "privacy",
    title: [
      "Aplicar una política de conservación",
      "Aplicar unha política de conservación",
    ],
    answer: [
      "Los datos vencen conforme a políticas aprobadas, que admiten excepciones justificadas. Un proceso en segundo plano aplica los vencimientos y cada actuación queda registrada en la auditoría.",
      "Os datos vencen conforme a políticas aprobadas, que admiten excepcións xustificadas. Un proceso en segundo plano aplica os vencementos e cada actuación queda rexistrada na auditoría.",
    ],
    actor: [
      "Perfil: personal con permiso de ejecución en materia de privacidad.",
      "Perfil: persoal con permiso de execución en materia de privacidade.",
    ],
  },
  {
    id: "actuacion",
    audience: "privacy",
    title: [
      "Ejecutar una actuación individual de privacidad",
      "Executar unha actuación individual de privacidade",
    ],
    answer: [
      "Permite suprimir o bloquear los datos de una persona concreta. Antes de aplicarse, la aplicación comprueba las excepciones vigentes y las dependencias con otros registros.",
      "Permite suprimir ou bloquear os datos dunha persoa concreta. Antes de aplicarse, a aplicación comproba as excepcións vixentes e as dependencias con outros rexistros.",
    ],
    actor: [
      "Perfil: personal con permiso de ejecución en materia de privacidad.",
      "Perfil: persoal con permiso de execución en materia de privacidade.",
    ],
  },
  {
    id: "recuperar",
    audience: "privacy",
    title: ["Recuperar una instalación", "Recuperar unha instalación"],
    answer: [
      "La recuperación combina una copia lógica, una restauración con el servicio cerrado y una conciliación previa a la reapertura. Las supresiones ya aplicadas no se restablecen con la copia.",
      "A recuperación combina unha copia lóxica, unha restauración co servizo pechado e unha conciliación previa á reapertura. As supresións xa aplicadas non se restablecen coa copia.",
    ],
    actor: [
      "Perfil: personal de operación autorizado.",
      "Perfil: persoal de operación autorizado.",
    ],
  },
];
