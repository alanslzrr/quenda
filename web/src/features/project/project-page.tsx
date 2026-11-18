import {
  ArrowRight,
  CalendarClock,
  CalendarSync,
  CloudCog,
  Code2,
  DatabaseBackup,
  FileLock2,
  Languages,
  type LucideIcon,
  PlayCircle,
  QrCode,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  TestTubes,
  UserPlus,
} from "lucide-react";
import { motion } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router";
import { usePreferences } from "../../app/preferences-provider";
import { useSession } from "../../app/session";
import { SettingsMenu } from "../../app/settings-menu";
import { AnimatedCounter } from "../../ui/animated-counter/animated-counter";
import { FaqSection } from "../../ui/blocks/faq-section/faq-section";
import { HeroShowcase } from "../../ui/blocks/hero/hero-showcase";
import { SiteFooter } from "../../ui/blocks/site-footer/site-footer";
import {
  SiteHeader,
  siteHeaderAction,
} from "../../ui/blocks/site-header/site-header";
import button from "../../ui/button/button.module.css";
import { motionTokens } from "../../ui/lib/motion-tokens";
import { useLiveReducedMotion } from "../../ui/lib/use-live-reduced-motion";
import { Architecture } from "./architecture";
import { audiences, type Text, useCases } from "./content";
import { BookingFlow, Tenancy } from "./diagrams";
import { Gallery } from "./gallery";
import { useCapture } from "./media";
import { MunicipalFeatures } from "./municipal-features";
import { Presentation } from "./presentation";
import styles from "./project.module.css";

const enter = [...motionTokens.ease.enter] as [number, number, number, number];
const sections = [
  "contexto",
  "ciudadania",
  "ayuntamientos",
  "tecnologia",
  "galeria",
  "casos-de-uso",
] as const;

/** Content that rises in once as it scrolls into view. */
function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const reduced = useLiveReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduced ? false : { opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.2 }}
      transition={{ duration: 0.7, ease: enter, delay: reduced ? 0 : delay }}
    >
      {children}
    </motion.div>
  );
}

function Intro({
  id,
  eyebrow,
  title,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <Reveal className={styles.intro}>
      <p className={styles.eyebrow}>{eyebrow}</p>
      <h2 id={id} className={styles.heading}>
        {title}
      </h2>
      {children && <p className={styles.lead}>{children}</p>}
    </Reveal>
  );
}

function Feature({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className={styles.feature}>
      <span className={styles.featureIcon} aria-hidden="true">
        <Icon size={18} strokeWidth={1.75} />
      </span>
      <span>
        <strong>{title}</strong>
        <span>{children}</span>
      </span>
    </li>
  );
}

/** Marks the section nearest the top of the viewport as current. */
function useCurrentSection() {
  const [current, setCurrent] = useState<string>();
  useEffect(() => {
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        setCurrent(sections.find((id) => visible.has(id)));
      },
      { rootMargin: "-30% 0px -55% 0px" },
    );
    for (const id of sections) {
      const node = document.getElementById(id);
      if (node) observer.observe(node);
    }
    return () => observer.disconnect();
  }, []);
  return current;
}

function Brand() {
  return (
    <Link to="/" className={styles.brand}>
      <span className={styles.brandMark} aria-hidden="true">
        q
      </span>
      <span className={styles.wordmark}>quenda</span>
    </Link>
  );
}

function RouterLink({
  to,
  className,
  children,
}: {
  to: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link to={to} className={className}>
      {children}
    </Link>
  );
}

/** The project page: purpose, functions and technical design of Quenda, for residents, municipal staff and technical readers. */
export function ProjectPage() {
  const { t, locale } = usePreferences();
  const { account } = useSession();
  const capture = useCapture();
  const current = useCurrentSection();
  const tx = (text: Text) => t(text[0], text[1]);

  useEffect(() => {
    document.title = t("Quenda · Proyecto", "Quenda · Proxecto");
  }, [t]);

  const items = [
    { value: "contexto", label: t("Contexto", "Contexto"), href: "#contexto" },
    {
      value: "ciudadania",
      label: t("Ciudadanía", "Cidadanía"),
      href: "#ciudadania",
    },
    {
      value: "ayuntamientos",
      label: t("Ayuntamientos", "Concellos"),
      href: "#ayuntamientos",
    },
    {
      value: "tecnologia",
      label: t("Tecnología", "Tecnoloxía"),
      href: "#tecnologia",
    },
    { value: "galeria", label: t("Galería", "Galería"), href: "#galeria" },
    {
      value: "casos-de-uso",
      label: t("Casos de uso", "Casos de uso"),
      href: "#casos-de-uso",
    },
  ];

  const faqItems = useCases.map((item) => ({
    id: item.id,
    question: tx(item.title),
    answer: tx(item.answer),
    meta: tx(item.actor),
    category: tx(audiences[item.audience]),
  }));

  const stats = [
    {
      value: useCases.length,
      label: t("casos de uso documentados", "casos de uso documentados"),
    },
    {
      value: 5,
      label: t(
        "módulos de dominio independientes",
        "módulos de dominio independentes",
      ),
    },
    {
      value: 4,
      label: t(
        "proveedores de nube con infraestructura declarada",
        "provedores de nube con infraestrutura declarada",
      ),
    },
    {
      value: 2,
      label: t("idiomas: gallego y castellano", "idiomas: galego e castelán"),
    },
  ];

  return (
    <div className={styles.page}>
      <a className={styles.skip} href="#contenido">
        {t("Saltar al contenido", "Saltar ao contido")}
      </a>
      <SiteHeader
        brand={<Brand />}
        items={items}
        current={current}
        actions={
          <>
            <Link
              className={siteHeaderAction.secondary}
              to={account ? "/perfil" : "/acceso"}
            >
              {account
                ? t("Mi cuenta", "A miña conta")
                : t("Acceder", "Acceder")}
            </Link>
            <Link className={siteHeaderAction.primary} to="/">
              {t("Reservar", "Reservar")}
            </Link>
          </>
        }
        tools={<SettingsMenu />}
        label={t("Secciones", "Seccións")}
        menuLabels={{
          open: t("Abrir menú", "Abrir menú"),
          close: t("Cerrar menú", "Pechar menú"),
        }}
      />

      <main id="contenido" tabIndex={-1} className={styles.main}>
        <HeroShowcase
          eyebrow={t(
            "Software libre para administraciones locales",
            "Software libre para administracións locais",
          )}
          title={t(
            "Reserva de instalaciones deportivas municipales",
            "Reserva de instalacións deportivas municipais",
          )}
          description={t(
            "Quenda es una plataforma de código abierto con la que la ciudadanía consulta la disponibilidad y gestiona sus reservas, y con la que cada ayuntamiento administra sus instalaciones, horarios, normas de uso y personal.",
            "Quenda é unha plataforma de código aberto coa que a cidadanía consulta a dispoñibilidade e xestiona as súas reservas, e coa que cada concello administra as súas instalacións, horarios, normas de uso e persoal.",
          )}
          actions={
            <>
              <Link
                className={`${button.button} ${button.primary} ${button.lg} ${styles.cta}`}
                to="/"
              >
                {t("Reservar una instalación", "Reservar unha instalación")}
                <ArrowRight size={16} aria-hidden="true" />
              </Link>
              <a
                className={`${button.button} ${button.secondary} ${button.lg} ${styles.cta}`}
                href="#presentacion"
              >
                <PlayCircle size={16} aria-hidden="true" />
                {t("Ver la presentación", "Ver a presentación")}
              </a>
            </>
          }
          fine={t(
            "Disponible en gallego y castellano. Publicado bajo licencia AGPL-3.0.",
            "Dispoñible en galego e castelán. Publicado baixo licenza AGPL-3.0.",
          )}
          address="quenda · Concello de Valdeira · Pista de pádel 1"
        >
          <img
            src={capture("horarios")}
            alt={t(
              "Selección de día y hora para una pista de pádel",
              "Selección de día e hora para unha pista de pádel",
            )}
            fetchPriority="high"
          />
        </HeroShowcase>

        <section
          id="contexto"
          className={styles.section}
          aria-labelledby="contexto-title"
        >
          <Intro
            id="contexto-title"
            eyebrow={t("Contexto", "Contexto")}
            title={t("El problema que aborda", "O problema que aborda")}
          >
            {t(
              "En muchos municipios, en especial en los de menor tamaño, la reserva de pistas, salas y pabellones se tramita por teléfono, por correo electrónico o de forma presencial. La disponibilidad real resulta difícil de consultar y cada modificación o cancelación requiere la intervención del personal municipal.",
              "En moitos concellos, en especial nos de menor tamaño, a reserva de pistas, salas e pavillóns tramítase por teléfono, por correo electrónico ou de forma presencial. A dispoñibilidade real resulta difícil de consultar e cada modificación ou cancelación require a intervención do persoal municipal.",
            )}
          </Intro>
          <div className={styles.pillars}>
            {[
              {
                title: t("Ciudadanía", "Cidadanía"),
                text: t(
                  "Consulta de horarios libres y reserva en cualquier momento, con las normas de uso y las condiciones de cancelación visibles antes de confirmar.",
                  "Consulta de horarios libres e reserva en calquera momento, coas normas de uso e as condicións de cancelación visibles antes de confirmar.",
                ),
              },
              {
                title: t("Ayuntamientos", "Concellos"),
                text: t(
                  "Menor carga administrativa, control sobre horarios y normas de uso, e indicadores para planificar la oferta de instalaciones.",
                  "Menor carga administrativa, control sobre horarios e normas de uso, e indicadores para planificar a oferta de instalacións.",
                ),
              },
              {
                title: t("Administración pública", "Administración pública"),
                text: t(
                  "Una misma instalación puede dar servicio a varios municipios, y la licencia garantiza que las mejoras queden a disposición del resto de administraciones.",
                  "Unha mesma instalación pode dar servizo a varios concellos, e a licenza garante que as melloras queden á disposición do resto de administracións.",
                ),
              },
            ].map(({ title, text }, index) => (
              <Reveal
                key={title}
                className={styles.pillar}
                delay={index * 0.06}
              >
                <h3>{title}</h3>
                <p>{text}</p>
              </Reveal>
            ))}
          </div>
          <Reveal className={styles.stats}>
            <ul>
              {stats.map((stat) => (
                <li key={stat.label}>
                  <span className={styles.statValue}>
                    <AnimatedCounter
                      value={stat.value}
                      animateOnView
                      locale={locale === "gl" ? "gl-ES" : "es-ES"}
                    />
                  </span>
                  <span className={styles.statLabel}>{stat.label}</span>
                </li>
              ))}
            </ul>
          </Reveal>
        </section>

        <section
          id="ciudadania"
          className={styles.section}
          aria-labelledby="ciudadania-title"
        >
          <div className={styles.split}>
            <div className={styles.splitText}>
              <Intro
                id="ciudadania-title"
                eyebrow={t("Ciudadanía", "Cidadanía")}
                title={t(
                  "Reserva guiada en cinco pasos",
                  "Reserva guiada en cinco pasos",
                )}
              >
                {t(
                  "La persona elige municipio, instalación, espacio, día y hora. La aplicación ofrece únicamente intervalos libres y muestra las condiciones aplicables antes de la confirmación.",
                  "A persoa escolle concello, instalación, espazo, día e hora. A aplicación ofrece unicamente intervalos libres e mostra as condicións aplicables antes da confirmación.",
                )}
              </Intro>
              <ul className={styles.features}>
                <Feature
                  icon={CalendarClock}
                  title={t(
                    "Disponibilidad actualizada",
                    "Dispoñibilidade actualizada",
                  )}
                >
                  {t(
                    "Horarios libres por espacio o por día y hora en todas las instalaciones.",
                    "Horarios libres por espazo ou por día e hora en todas as instalacións.",
                  )}
                </Feature>
                <Feature
                  icon={RefreshCcw}
                  title={t("Cambios y cancelaciones", "Cambios e cancelacións")}
                >
                  {t(
                    "Dentro del plazo que publica cada ayuntamiento.",
                    "Dentro do prazo que publica cada concello.",
                  )}
                </Feature>
                <Feature
                  icon={QrCode}
                  title={t("Código de acceso", "Código de acceso")}
                >
                  {t(
                    "El personal comprueba la reserva y registra la llegada.",
                    "O persoal comproba a reserva e rexistra a chegada.",
                  )}
                </Feature>
                <Feature
                  icon={CalendarSync}
                  title={t("Calendario personal", "Calendario persoal")}
                >
                  {t(
                    "Descarga iCalendar o suscripción revocable.",
                    "Descarga iCalendar ou subscrición revogable.",
                  )}
                </Feature>
                <Feature
                  icon={Sparkles}
                  title={t("Horarios habituales", "Horarios habituais")}
                >
                  {t(
                    "Sugerencias calculadas a partir de las reservas propias, sin perfiles y desactivables.",
                    "Suxestións calculadas a partir das reservas propias, sen perfís e desactivables.",
                  )}
                </Feature>
                <Feature
                  icon={Languages}
                  title={t(
                    "Accesibilidad e idiomas",
                    "Accesibilidade e idiomas",
                  )}
                >
                  {t(
                    "Gallego y castellano, tema claro u oscuro y uso completo con teclado y lector de pantalla.",
                    "Galego e castelán, tema claro ou escuro e uso completo con teclado e lector de pantalla.",
                  )}
                </Feature>
              </ul>
            </div>
            <Reveal className={styles.phone} delay={0.1}>
              <img
                src={capture("movil-instalaciones")}
                alt={t(
                  "Selección de instalación en un teléfono móvil",
                  "Selección de instalación nun teléfono móbil",
                )}
                loading="lazy"
              />
            </Reveal>
          </div>
          <Reveal>
            <BookingFlow />
          </Reveal>
        </section>

        <section
          id="ayuntamientos"
          className={styles.section}
          aria-labelledby="ayuntamientos-title"
        >
          <Intro
            id="ayuntamientos-title"
            eyebrow={t("Ayuntamientos", "Concellos")}
            title={t(
              "Herramientas de gestión municipal",
              "Ferramentas de xestión municipal",
            )}
          >
            {t(
              "El personal municipal mantiene el catálogo, los calendarios y las normas de uso, consulta los indicadores de uso y delega permisos. Cada cambio queda versionado y registrado en la auditoría.",
              "O persoal municipal mantén o catálogo, os calendarios e as normas de uso, consulta os indicadores de uso e delega permisos. Cada cambio queda versionado e rexistrado na auditoría.",
            )}
          </Intro>
          <Reveal>
            <MunicipalFeatures />
          </Reveal>
        </section>

        <section className={styles.section} aria-labelledby="plataforma-title">
          <div className={styles.split}>
            <div className={styles.splitText}>
              <Intro
                id="plataforma-title"
                eyebrow={t("Plataforma", "Plataforma")}
                title={t(
                  "Despliegue compartido entre municipios",
                  "Despregamento compartido entre concellos",
                )}
              >
                {t(
                  "Una sola instalación de Quenda puede alojar varios municipios. Cada uno conserva sus datos, sus permisos y su apariencia, y la ciudadanía utiliza una única cuenta para reservar en cualquiera de ellos. Un ayuntamiento también puede desplegar su propia instalación en un único servidor.",
                  "Unha soa instalación de Quenda pode aloxar varios concellos. Cada un conserva os seus datos, os seus permisos e a súa aparencia, e a cidadanía utiliza unha única conta para reservar en calquera deles. Un concello tamén pode despregar a súa propia instalación nun único servidor.",
                )}
              </Intro>
              <ul className={`${styles.features} ${styles.featuresSingle}`}>
                <Feature
                  icon={UserPlus}
                  title={t("Alta de municipios", "Alta de concellos")}
                >
                  {t(
                    "La operación de la plataforma incorpora el municipio e invita a su responsable por correo electrónico.",
                    "A operación da plataforma incorpora o concello e invita á súa persoa responsable por correo electrónico.",
                  )}
                </Feature>
                <Feature
                  icon={FileLock2}
                  title={t("Conservación de datos", "Conservación de datos")}
                >
                  {t(
                    "Vencimientos conforme a políticas aprobadas, con excepciones justificadas y auditoría.",
                    "Vencementos conforme a políticas aprobadas, con excepcións xustificadas e auditoría.",
                  )}
                </Feature>
                <Feature
                  icon={DatabaseBackup}
                  title={t("Copia y recuperación", "Copia e recuperación")}
                >
                  {t(
                    "Copia lógica, restauración con el servicio cerrado y conciliación previa a la reapertura.",
                    "Copia lóxica, restauración co servizo pechado e conciliación previa á reapertura.",
                  )}
                </Feature>
              </ul>
            </div>
            <Reveal delay={0.1}>
              <Tenancy />
            </Reveal>
          </div>
        </section>

        <section
          id="tecnologia"
          className={styles.section}
          aria-labelledby="tecnologia-title"
        >
          <Intro
            id="tecnologia-title"
            eyebrow={t("Tecnología", "Tecnoloxía")}
            title={t(
              "Arquitectura y garantías técnicas",
              "Arquitectura e garantías técnicas",
            )}
          >
            {t(
              "Quenda es un monolito modular en TypeScript sobre PostgreSQL. Se distribuye como imágenes OCI y puede desplegarse en cualquier proveedor de nube o en un servidor propio.",
              "Quenda é un monolito modular en TypeScript sobre PostgreSQL. Distribúese como imaxes OCI e pode despregarse en calquera provedor de nube ou nun servidor propio.",
            )}
          </Intro>
          <Reveal>
            <Architecture />
          </Reveal>
          <div className={styles.techGrid}>
            <Reveal className={styles.techCard}>
              <h3>
                <ShieldCheck size={18} aria-hidden="true" />
                {t("Seguridad y privacidad", "Seguridade e privacidade")}
              </h3>
              <ul>
                <li>
                  {t(
                    "Aislamiento por municipio en la base de datos mediante seguridad a nivel de fila y claves compuestas.",
                    "Illamento por concello na base de datos mediante seguridade a nivel de fila e claves compostas.",
                  )}
                </li>
                <li>
                  {t(
                    "Verificación en dos pasos obligatoria para cualquier permiso de gestión.",
                    "Verificación en dous pasos obrigatoria para calquera permiso de xestión.",
                  )}
                </li>
                <li>
                  {t(
                    "Comandos idempotentes, protección de origen, límites de peticiones y registro de auditoría.",
                    "Comandos idempotentes, protección de orixe, límites de peticións e rexistro de auditoría.",
                  )}
                </li>
                <li>
                  {t(
                    "Las consultas públicas no muestran titulares y las exportaciones excluyen nombres y correos.",
                    "As consultas públicas non mostran titulares e as exportacións exclúen nomes e correos.",
                  )}
                </li>
                <li>
                  {t(
                    "Contenedores de solo lectura, sin capacidades adicionales ni elevación de privilegios.",
                    "Contedores de só lectura, sen capacidades adicionais nin elevación de privilexios.",
                  )}
                </li>
              </ul>
            </Reveal>
            <Reveal className={styles.techCard} delay={0.05}>
              <h3>
                <TestTubes size={18} aria-hidden="true" />
                {t("Verificación automática", "Verificación automática")}
              </h3>
              <ul>
                <li>
                  {t(
                    "Comprobación de tipos, análisis estático, pruebas unitarias y de HTTP, y validación del contrato OpenAPI.",
                    "Comprobación de tipos, análise estática, probas unitarias e de HTTP, e validación do contrato OpenAPI.",
                  )}
                </li>
                <li>
                  {t(
                    "Pruebas de integración contra PostgreSQL real: permisos, aislamiento, privacidad y recuperación.",
                    "Probas de integración contra PostgreSQL real: permisos, illamento, privacidade e recuperación.",
                  )}
                </li>
                <li>
                  {t(
                    "Recorridos completos en escritorio, móvil y tableta con análisis automático de WCAG 2.1, niveles A y AA.",
                    "Percorridos completos en escritorio, móbil e tableta con análise automática de WCAG 2.1, niveis A e AA.",
                  )}
                </li>
                <li>
                  {t(
                    "Pruebas de las imágenes y del despliegue: arranque, migraciones, TLS y caída de la base de datos.",
                    "Probas das imaxes e do despregamento: arranque, migracións, TLS e caída da base de datos.",
                  )}
                </li>
              </ul>
            </Reveal>
            <Reveal className={styles.techCard} delay={0.1}>
              <h3>
                <Code2 size={18} aria-hidden="true" />
                {t(
                  "Tecnologías y formatos abiertos",
                  "Tecnoloxías e formatos abertos",
                )}
              </h3>
              <dl className={styles.stack}>
                <dt>API</dt>
                <dd>Node.js 24 · TypeScript · Fastify 5 · Better Auth</dd>
                <dt>{t("Datos", "Datos")}</dt>
                <dd>
                  {t(
                    "PostgreSQL 17 con migraciones versionadas",
                    "PostgreSQL 17 con migracións versionadas",
                  )}
                </dd>
                <dt>Web</dt>
                <dd>React 19 · React Router · TanStack Query · Vite</dd>
                <dt>{t("Entrega", "Entrega")}</dt>
                <dd>
                  {t(
                    "Imágenes OCI, Docker Compose y OpenTofu",
                    "Imaxes OCI, Docker Compose e OpenTofu",
                  )}
                </dd>
              </dl>
              <ul
                className={styles.chips}
                aria-label={t("Estándares", "Estándares")}
              >
                {[
                  "OpenAPI 3",
                  "iCalendar",
                  "JSON Schema",
                  "CSV",
                  "OCI",
                  "AGPL-3.0",
                ].map((chip) => (
                  <li key={chip}>{chip}</li>
                ))}
              </ul>
            </Reveal>
            <Reveal className={styles.techCard} delay={0.15}>
              <h3>
                <CloudCog size={18} aria-hidden="true" />
                {t("Despliegue", "Despregamento")}
              </h3>
              <p>
                {t(
                  "El repositorio incluye una composición de referencia para un único servidor y la infraestructura declarada para OCI, AWS, Azure y GCP. Cada proveedor se valida en local contra su emulador antes de publicar una revisión.",
                  "O repositorio inclúe unha composición de referencia para un único servidor e a infraestrutura declarada para OCI, AWS, Azure e GCP. Cada provedor valídase en local contra o seu emulador antes de publicar unha revisión.",
                )}
              </p>
              <ul
                className={styles.chips}
                aria-label={t("Proveedores de nube", "Provedores de nube")}
              >
                {["OCI", "AWS", "Azure", "GCP"].map((chip) => (
                  <li key={chip}>{chip}</li>
                ))}
              </ul>
            </Reveal>
          </div>
        </section>

        <section
          id="galeria"
          className={styles.section}
          aria-labelledby="galeria-title"
        >
          <Intro
            id="galeria-title"
            eyebrow={t("Galería", "Galería")}
            title={t("Galería de la aplicación", "Galería da aplicación")}
          >
            {t(
              "Presentación en vídeo y capturas de la aplicación con los datos ficticios de la demostración. Las capturas se muestran en el tema activo de esta página.",
              "Presentación en vídeo e capturas da aplicación cos datos ficticios da demostración. As capturas móstranse no tema activo desta páxina.",
            )}
          </Intro>
          <Reveal>
            <Presentation />
          </Reveal>
          <Reveal>
            <Gallery />
          </Reveal>
        </section>

        <section
          id="casos-de-uso"
          className={styles.section}
          aria-label={t("Casos de uso", "Casos de uso")}
        >
          <FaqSection
            variant="columns"
            eyebrow={t("Funciones", "Funcións")}
            title={t("Casos de uso", "Casos de uso")}
            description={t(
              "Funciones de la aplicación agrupadas por perfil. Cada caso de uso está especificado en la documentación técnica y cuenta con una guía ilustrada.",
              "Funcións da aplicación agrupadas por perfil. Cada caso de uso está especificado na documentación técnica e conta cunha guía ilustrada.",
            )}
            items={faqItems}
            labels={{
              topics: t("Perfiles", "Perfís"),
              search: t("Buscar casos de uso", "Buscar casos de uso"),
              searchPlaceholder: t(
                "Reserva, permisos, privacidad",
                "Reserva, permisos, privacidade",
              ),
              results: (count) =>
                t(`${count} resultados`, `${count} resultados`),
              total: (count) =>
                t(`${count} casos de uso`, `${count} casos de uso`),
              empty: (query) =>
                t(
                  `Ningún caso de uso contiene «${query}».`,
                  `Ningún caso de uso contén «${query}».`,
                ),
              clear: t("Borrar la búsqueda", "Borrar a busca"),
            }}
          />
        </section>

        <section className={styles.closing} aria-labelledby="cierre-title">
          <Reveal className={styles.closingInner}>
            <h2 id="cierre-title" className={styles.heading}>
              {t(
                "Código abierto y reutilizable",
                "Código aberto e reutilizable",
              )}
            </h2>
            <p className={styles.lead}>
              {t(
                "Quenda se publica bajo la licencia AGPL-3.0. Cualquier administración puede utilizarlo, adaptarlo y desplegarlo. Quien lo ofrezca como servicio en red debe poner sus modificaciones a disposición de las personas usuarias.",
                "Quenda publícase baixo a licenza AGPL-3.0. Calquera administración pode utilizalo, adaptalo e despregalo. Quen o ofreza como servizo en rede debe poñer as súas modificacións á disposición das persoas usuarias.",
              )}
            </p>
            <div className={styles.closingActions}>
              <Link
                className={`${button.button} ${button.primary} ${button.lg} ${styles.cta}`}
                to="/"
              >
                {t("Ir a reservas", "Ir a reservas")}
                <ArrowRight size={16} aria-hidden="true" />
              </Link>
              <a
                className={`${button.button} ${button.secondary} ${button.lg} ${styles.cta}`}
                href="/legal/source"
              >
                {t("Código fuente", "Código fonte")}
              </a>
            </div>
          </Reveal>
        </section>
      </main>

      <SiteFooter
        mark="quenda"
        brand={<Brand />}
        tagline={t(
          "Plataforma libre para la consulta y reserva de instalaciones deportivas municipales.",
          "Plataforma libre para a consulta e reserva de instalacións deportivas municipais.",
        )}
        linkComponent={RouterLink}
        labels={{
          navigation: t("Pie de página", "Pé de páxina"),
          legal: t("Información legal", "Información legal"),
        }}
        columns={[
          {
            title: t("Aplicación", "Aplicación"),
            links: [
              { label: t("Reservar", "Reservar"), href: "/" },
              {
                label: account
                  ? t("Mi cuenta", "A miña conta")
                  : t("Acceder", "Acceder"),
                href: account ? "/perfil" : "/acceso",
              },
              {
                label: t("Crear una cuenta", "Crear unha conta"),
                href: "/registro",
              },
            ],
          },
          {
            title: t("Proyecto", "Proxecto"),
            links: [
              { label: t("Contexto", "Contexto"), href: "#contexto" },
              { label: t("Galería", "Galería"), href: "#galeria" },
              {
                label: t("Casos de uso", "Casos de uso"),
                href: "#casos-de-uso",
              },
            ],
          },
          {
            title: t("Código abierto", "Código aberto"),
            links: [
              {
                label: t("Código fuente", "Código fonte"),
                href: "/legal/source",
                document: true,
              },
              { label: t("Tecnología", "Tecnoloxía"), href: "#tecnologia" },
              {
                label: t("Accesibilidad", "Accesibilidade"),
                href: "/accesibilidad",
              },
            ],
          },
        ]}
        legal={[
          { label: t("Privacidad", "Privacidade"), href: "/privacidad" },
          { label: t("Aviso legal", "Aviso legal"), href: "/aviso-legal" },
        ]}
        closing={t(
          "Quenda · Software libre · AGPL-3.0-only",
          "Quenda · Software libre · AGPL-3.0-only",
        )}
      />
    </div>
  );
}

export default ProjectPage;
