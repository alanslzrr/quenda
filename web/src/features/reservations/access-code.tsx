import { accessCodeModules } from "./access-code-model";

/**
 * A QR code drawn as one SVG path. Dark modules on a white field with the
 * standard quiet zone, whatever the theme, so phone cameras can read it.
 */
export function AccessCode({ value, label }: { value: string; label: string }) {
  const { data, size } = accessCodeModules(value);
  let path = "";
  data.forEach((row, y) => {
    let x = 0;
    while (x < size) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < size && row[x]) x++;
      path += `M${start} ${y}h${x - start}v1h${start - x}z`;
    }
  });
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      width="200"
      height="200"
      shapeRendering="crispEdges"
      style={{
        background: "#fff",
        display: "block",
        maxWidth: "100%",
        height: "auto",
      }}
    >
      <path d={path} fill="#000" />
    </svg>
  );
}
