import { type ReactNode, useLayoutEffect, useRef } from "react";

/**
 * Fades its content in whenever `scene` changes. Nothing remounts: the browser animates the existing node and keeps no
 * style afterwards, so sticky and fixed descendants behave as before. Skipped when the system asks for reduced motion.
 */
export function RouteFade({
  scene,
  children,
}: {
  /** What counts as a new screen here; `undefined` leaves the content still. */
  scene: string | undefined;
  children: ReactNode;
}) {
  const node = useRef<HTMLDivElement>(null);
  const shown = useRef(scene);
  useLayoutEffect(() => {
    if (shown.current === scene) return;
    shown.current = scene;
    const target = node.current;
    if (
      !scene ||
      !target?.animate ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const animation = target.animate(
      [
        { opacity: 0, transform: "translateY(6px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 240, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
    );
    return () => animation.cancel();
  }, [scene]);
  return (
    <div ref={node} style={{ minWidth: 0 }}>
      {children}
    </div>
  );
}
