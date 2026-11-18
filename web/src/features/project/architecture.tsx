import { usePreferences } from "../../app/preferences-provider";
import styles from "./architecture.module.css";

type Box = { x: number; y: number; w: number; h: number };

function Node({
  box,
  title,
  lines,
  tone,
}: {
  box: Box;
  title: string;
  lines: string[];
  tone?: "primary" | "data";
}) {
  return (
    <g>
      <rect
        className={styles.node}
        data-tone={tone}
        x={box.x}
        y={box.y}
        width={box.w}
        height={box.h}
        rx={14}
      />
      <text className={styles.title} x={box.x + 16} y={box.y + 28}>
        {title}
      </text>
      {lines.map((line, index) => (
        <text
          key={line}
          className={styles.detail}
          x={box.x + 16}
          y={box.y + 48 + index * 18}
        >
          {line}
        </text>
      ))}
    </g>
  );
}

function Edge({
  d,
  label,
  at,
}: {
  d: string;
  label?: string;
  at?: [number, number];
}) {
  return (
    <g>
      <path className={styles.edge} d={d} markerEnd="url(#arrow)" />
      <path className={styles.flow} d={d} />
      {label && at && (
        <g>
          <rect
            className={styles.pill}
            x={at[0] - (label.length * 6.4 + 16) / 2}
            y={at[1] - 10}
            width={label.length * 6.4 + 16}
            height={20}
            rx={10}
          />
          <text className={styles.pillText} x={at[0]} y={at[1] + 4}>
            {label}
          </text>
        </g>
      )}
    </g>
  );
}

/**
 * Components of a deployment and the connections between them: who calls whom, over which protocol, and with which
 * database role each process connects.
 */
export function Architecture() {
  const { t } = usePreferences();
  const top = 34;
  const modules = [
    t("Identidad", "Identidade"),
    t("Catálogo", "Catálogo"),
    t("Reservas", "Reservas"),
    t("Colaboración", "Colaboración"),
    t("Comunicaciones", "Comunicacións"),
  ];
  const roles = [
    { name: "quenda_migrator", y: 130 },
    { name: "quenda_domain", y: 186 },
    { name: "quenda_auth", y: 226 },
    { name: "quenda_worker", y: 300 },
  ];
  return (
    <figure className={styles.figure}>
      <div className={styles.scroller}>
        <svg
          className={styles.svg}
          viewBox="0 0 1200 520"
          role="img"
          aria-labelledby="architecture-title architecture-desc"
        >
          <title id="architecture-title">
            {t("Arquitectura de Quenda", "Arquitectura de Quenda")}
          </title>
          <desc id="architecture-desc">
            {t(
              "El navegador y las aplicaciones de calendario acceden por HTTPS al servidor web, que entrega la aplicación y reenvía las peticiones a la API. La API, el worker y las migraciones se conectan a PostgreSQL con roles distintos. El worker envía el correo a través del servidor SMTP de la entidad.",
              "O navegador e as aplicacións de calendario acceden por HTTPS ao servidor web, que entrega a aplicación e reenvía as peticións á API. A API, o worker e as migracións conéctanse a PostgreSQL con roles distintos. O worker envía o correo a través do servidor SMTP da entidade.",
            )}
          </desc>
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path className={styles.arrow} d="M0 0 L10 5 L0 10 z" />
            </marker>
          </defs>

          <g className={styles.columns}>
            <text x={0} y={14}>
              {t("Acceso", "Acceso")}
            </text>
            <text x={320} y={14}>
              {t("Entrada", "Entrada")}
            </text>
            <text x={600} y={14}>
              {t("Aplicación", "Aplicación")}
            </text>
            <text x={960} y={14}>
              {t("Datos y servicios", "Datos e servizos")}
            </text>
          </g>

          <g transform={`translate(0 ${top})`}>
            <Edge d="M210 148 H265 V200 H318" label="HTTPS" at={[265, 174]} />
            <Edge
              d="M210 288 H265 V236 H318"
              label="iCalendar"
              at={[265, 262]}
            />
            <Edge d="M520 218 H598" label="/api" at={[559, 206]} />
            <Edge d="M880 32 H920 V130 H974" />
            <Edge d="M880 186 H974" />
            <Edge d="M880 226 H974" />
            <Edge d="M880 400 H920 V300 H974" />
            <Edge d="M880 438 H958" label="SMTP · TLS" at={[920, 426]} />

            <Node
              box={{ x: 0, y: 110, w: 210, h: 76 }}
              title={t("Navegador", "Navegador")}
              lines={[
                t("Aplicación web instalable", "Aplicación web instalable"),
              ]}
            />
            <Node
              box={{ x: 0, y: 250, w: 210, h: 76 }}
              title={t("Calendarios", "Calendarios")}
              lines={[t("Suscripción iCalendar", "Subscrición iCalendar")]}
            />
            <Node
              box={{ x: 320, y: 160, w: 200, h: 116 }}
              title="Web"
              lines={[
                t("nginx sin privilegios", "nginx sen privilexios"),
                t("Aplicación y cabeceras", "Aplicación e cabeceiras"),
                t("de seguridad", "de seguridade"),
              ]}
            />
            <Node
              box={{ x: 600, y: 0, w: 280, h: 64 }}
              title={t("Migraciones", "Migracións")}
              lines={[
                t("Versionadas e inmutables", "Versionadas e inmutables"),
              ]}
            />

            <g>
              <rect
                className={styles.node}
                data-tone="primary"
                x={600}
                y={96}
                width={280}
                height={250}
                rx={14}
              />
              <text className={styles.title} x={616} y={124}>
                API
              </text>
              <text className={styles.detail} x={616} y={144}>
                Fastify 5 · Better Auth · OpenAPI 3
              </text>
              <text className={styles.caption} x={616} y={174}>
                {t("Módulos", "Módulos")}
              </text>
              {modules.map((name, index) => {
                const x = 616 + (index % 2) * 128;
                const y = 184 + Math.floor(index / 2) * 36;
                return (
                  <g key={name}>
                    <rect
                      className={styles.chip}
                      x={x}
                      y={y}
                      width={120}
                      height={28}
                      rx={8}
                    />
                    <text className={styles.chipText} x={x + 60} y={y + 18}>
                      {name}
                    </text>
                  </g>
                );
              })}
              <text className={styles.caption} x={616} y={330}>
                {t(
                  "Dependencias entre módulos comprobadas",
                  "Dependencias entre módulos comprobadas",
                )}
              </text>
            </g>

            <Node
              box={{ x: 600, y: 378, w: 280, h: 96 }}
              title="Worker"
              lines={[
                t(
                  "Cola de correo e informes mensuales",
                  "Cola de correo e informes mensuais",
                ),
                t(
                  "Vencimientos de conservación",
                  "Vencementos de conservación",
                ),
              ]}
            />

            <g>
              <rect
                className={styles.node}
                data-tone="data"
                x={960}
                y={40}
                width={240}
                height={300}
                rx={14}
              />
              <text className={styles.title} x={976} y={68}>
                PostgreSQL 17
              </text>
              <text className={styles.detail} x={976} y={88}>
                {t("Seguridad a nivel de fila", "Seguridade a nivel de fila")}
              </text>
              <text className={styles.detail} x={976} y={106}>
                {t("por municipio", "por concello")}
              </text>
              {roles.map((role) => (
                <g key={role.name}>
                  <rect
                    className={styles.role}
                    x={976}
                    y={role.y - 14}
                    width={208}
                    height={28}
                    rx={8}
                  />
                  <text className={styles.roleText} x={988} y={role.y + 4}>
                    {role.name}
                  </text>
                </g>
              ))}
            </g>

            <Node
              box={{ x: 960, y: 400, w: 240, h: 76 }}
              title={t("Servidor de correo", "Servidor de correo")}
              lines={[t("SMTP de la entidad", "SMTP da entidade")]}
            />
          </g>
        </svg>
      </div>
      <figcaption>
        {t(
          "Cada proceso se conecta a la base de datos con un rol propio y con los privilegios mínimos que necesita. El aislamiento entre municipios se aplica en PostgreSQL mediante seguridad a nivel de fila.",
          "Cada proceso conéctase á base de datos cun rol propio e cos privilexios mínimos que precisa. O illamento entre concellos aplícase en PostgreSQL mediante seguridade a nivel de fila.",
        )}
      </figcaption>
    </figure>
  );
}
