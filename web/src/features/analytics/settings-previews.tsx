import styles from "./settings-panel.module.css";

type Values = (number | null)[];

/** Keeps at most `count` points, evenly spread, so a long period still draws as a short readable shape. */
function sample(values: Values, count: number) {
  if (values.length <= count) return values;
  return Array.from(
    { length: count },
    (_, n) =>
      values[Math.round((n * (values.length - 1)) / (count - 1))] ?? null,
  );
}

function path(
  values: Values,
  width: number,
  height: number,
  pad: number,
  top: number,
) {
  const step = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0;
  let d = "",
    open = false;
  values.forEach((value, n) => {
    if (value === null) {
      open = false;
      return;
    }
    const x = pad + n * step,
      y =
        height -
        pad -
        (Math.min(Math.max(value, 0), top) / top) * (height - pad * 2);
    d += `${open ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    open = true;
  });
  return d;
}

/**
 * A miniature of the occupancy evolution as it would be drawn: a line (with the previous period dashed), bars, or
 * table rows. Drawn from the period on screen, so each option previews the person's own data.
 */
export function MiniEvolution({
  current,
  previous,
  kind,
  width,
  height,
}: {
  current: Values;
  previous?: Values | undefined;
  kind: "line" | "bars" | "table";
  width: number;
  height: number;
}) {
  const pad = Math.max(3, Math.round(height / 12));
  const points = Math.max(4, Math.min(24, Math.round(width / 10)));
  const now = sample(current.length ? current : [30, 45, 40, 60, 55], points);
  const before = previous ? sample(previous, points) : undefined;
  // Scaled to the period's own range, so a quiet period still shows its shape at this size.
  const top =
    Math.max(
      10,
      ...[...now, ...(before ?? [])].filter((v): v is number => v !== null),
    ) * 1.15;
  if (kind === "table") {
    const rows = Math.max(3, Math.floor((height - pad * 2) / 9));
    return (
      <svg
        className={styles.mini}
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        aria-hidden="true"
      >
        {Array.from({ length: rows }, (_, n) => {
          const y = pad + n * ((height - pad * 2) / rows);
          const value = now[n % now.length] ?? 0;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: Rows are positions in a fixed sketch.
            <g key={n}>
              <rect
                className={n === 0 ? styles.miniHead : styles.miniCell}
                x={pad}
                y={y + 1}
                width={width * 0.32}
                height={4}
                rx={2}
              />
              <rect
                className={n === 0 ? styles.miniHead : styles.miniCell}
                x={width * 0.48}
                y={y + 1}
                width={
                  n === 0
                    ? width * 0.2
                    : Math.max(6, (width * 0.4 * value) / top)
                }
                height={4}
                rx={2}
              />
            </g>
          );
        })}
      </svg>
    );
  }
  if (kind === "bars") {
    const slot = (width - pad * 2) / now.length;
    return (
      <svg
        className={styles.mini}
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        aria-hidden="true"
      >
        <line
          className={styles.miniAxis}
          x1={pad}
          x2={width - pad}
          y1={height - pad}
          y2={height - pad}
        />
        {now.map((value, n) => {
          const h = ((value ?? 0) / top) * (height - pad * 2);
          return (
            <rect
              // biome-ignore lint/suspicious/noArrayIndexKey: Positions are the identity of a fixed sample.
              key={n}
              className={styles.miniBar}
              x={pad + n * slot + slot * 0.15}
              y={height - pad - h}
              width={slot * 0.7}
              height={h}
              rx={Math.min(2, slot * 0.2)}
            />
          );
        })}
        {before ? (
          <path
            className={styles.miniPrevious}
            d={path(before, width, height, pad + slot / 2, top)}
          />
        ) : null}
      </svg>
    );
  }
  return (
    <svg
      className={styles.mini}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      aria-hidden="true"
    >
      <line
        className={styles.miniAxis}
        x1={pad}
        x2={width - pad}
        y1={height - pad}
        y2={height - pad}
      />
      {before ? (
        <path
          className={styles.miniPrevious}
          d={path(before, width, height, pad, top)}
        />
      ) : null}
      <path
        className={styles.miniLine}
        d={path(now, width, height, pad, top)}
      />
    </svg>
  );
}

/** A few cells of the demand table, written the way the chosen metric writes them. */
export function MiniDemand({
  cells,
  compact = false,
}: {
  cells: { text: string; level: number }[];
  compact?: boolean;
}) {
  return (
    <span
      className={styles.miniDemand}
      data-compact={compact || undefined}
      aria-hidden="true"
    >
      {cells.map((cell, n) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Positions are the identity of a fixed sample.
        <span key={n} data-level={cell.level}>
          {cell.text}
        </span>
      ))}
    </span>
  );
}
