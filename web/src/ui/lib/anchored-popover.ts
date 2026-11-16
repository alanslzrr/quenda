import { type RefObject, useCallback, useId } from "react";

/**
 * Whether a floating panel can be lifted into the top layer and stay tethered to its trigger through CSS anchor
 * positioning. In the top layer no ancestor's stacking context, `overflow` or `transform` can paint over or clip it.
 * Browsers without both features keep the in-flow, absolutely positioned panel, which is the styled fallback.
 */
export const anchoredPopovers =
  typeof HTMLElement !== "undefined" &&
  Object.hasOwn(HTMLElement.prototype, "popover") &&
  typeof CSS !== "undefined" &&
  CSS.supports("anchor-name: --a") &&
  CSS.supports("position-area: block-end");

/** A per-instance dashed ident that pairs a trigger's `anchor-name` with its panel's `position-anchor`. */
export function useAnchorName() {
  return `--anchor-${useId().replace(/[^\w-]/g, "")}`;
}

/**
 * A callback ref that shows the panel as a manual popover while it is mounted. Manual keeps dismissal in the
 * component's own state, so an exit animation still runs in the top layer; the popover is hidden only when the panel
 * unmounts. The optional ref object keeps receiving the element for the component's own use.
 */
export function useTopLayerRef<T extends HTMLElement>(ref?: RefObject<T | null>) {
  return useCallback(
    (panel: T | null) => {
      if (ref) ref.current = panel;
      if (!panel) return;
      if (anchoredPopovers && panel.hasAttribute("popover")) panel.showPopover();
      return () => {
        if (ref) ref.current = null;
        if (panel.matches(":popover-open")) panel.hidePopover();
      };
    },
    [ref],
  );
}

/** Attributes for the floating panel: the popover is only declared where it can be anchored. */
export function topLayerProps(anchor: string) {
  return anchoredPopovers
    ? ({ popover: "manual", style: { positionAnchor: anchor } } as const)
    : {};
}

/** The trigger's anchor name; harmless where anchor positioning is unsupported. */
export function anchorStyle(anchor: string) {
  return anchoredPopovers ? { anchorName: anchor } : undefined;
}
