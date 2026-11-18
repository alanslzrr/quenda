import { forwardRef, useCallback, useId, useRef } from "react";
import type { ComponentProps, InputHTMLAttributes, MouseEvent } from "react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { Search, X as Xmark } from "lucide-react";
import { motionTokens } from "../motion-tokens";
import { useLiveReducedMotion } from "../lib/use-live-reduced-motion";
import styles from "./search-field.module.css";
export interface SearchFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  /** Accessible name of the clear button, in the application's language. */
  clearLabel: string;
}
/** The exiting control may remain painted briefly, but must not be interactive. */
const ClearControl = forwardRef<HTMLButtonElement, ComponentProps<typeof motion.button>>(function ClearControl(props, ref) {
  const present = useIsPresent();
  return <motion.button {...props} ref={ref} disabled={!present || props.disabled} tabIndex={present ? 0 : -1} aria-hidden={!present || undefined} inert={!present || undefined} />;
});
export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(
  function SearchField(
    { label, value, onValueChange, clearLabel, onChange, onKeyDown, onCompositionStart, onCompositionEnd, onBlur, id, className, ...props },
    ref,
  ) {
    const generated = useId();
    const controlId = id ?? generated;
    const reduced = useLiveReducedMotion();
    const inputRef = useRef<HTMLInputElement | null>(null);
    const composing = useRef(false);
    const setRefs = useCallback((node: HTMLInputElement | null) => {
      inputRef.current = node;
      if (typeof ref === "function") {
        const cleanup = (ref as (value: HTMLInputElement | null) => void | (() => void))(node);
        if (typeof cleanup === "function") return () => { inputRef.current = null; cleanup(); };
      } else if (ref) ref.current = node;
    }, [ref]);
    // Clearing returns focus to the field, since the clear button unmounts under the pointer.
    function clear(event: MouseEvent<HTMLButtonElement>) {
      if (props.disabled || props.readOnly) return;
      const input = inputRef.current;
      const button = event.currentTarget;
      const doc = input?.ownerDocument;
      const previous = doc?.activeElement;
      onValueChange("");
      if (!input || inputRef.current !== input || !doc) return;
      const current = doc.activeElement;
      // A departing clear button may lose focus as it becomes inert. A focus
      // change to another host control belongs to the host callback.
      if (current === previous || (current === doc.body && previous === button &&
          (button.disabled || !button.isConnected || !!button.closest("[inert]")))) input.focus();
    }
    return (
      <div className={styles.field}>
        <label htmlFor={controlId}>{label}</label>
        <div className={styles.shell} data-filled={value ? "true" : undefined}>
          <Search width={18} height={18} aria-hidden="true" />
          <input
            data-border-focus=""
            {...props}
            ref={setRefs}
            id={controlId}
            type="search"
            value={value}
            onChange={(event) => { const next = event.target.value; onChange?.(event); onValueChange(next); }}
            onCompositionStart={(event) => { composing.current = true; onCompositionStart?.(event); }}
            onCompositionEnd={(event) => { composing.current = false; onCompositionEnd?.(event); }}
            onBlur={(event) => { composing.current = false; onBlur?.(event); }}
            onKeyDown={(event) => {
              onKeyDown?.(event);
              if (inputRef.current !== event.currentTarget || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.key !== "Escape" || composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || props.disabled || props.readOnly || !value) return;
              event.preventDefault();
              onValueChange("");
            }}
            className={[styles.input, className].filter(Boolean).join(" ")}
          />
          {/* The clear button has a reserved slot, so the field never changes width when it appears or leaves. */}
          <span className={styles.clearSlot}>
            <AnimatePresence initial={false}>
              {value ? (
                <ClearControl
                  key="clear"
                  type="button"
                  disabled={props.disabled || props.readOnly}
                  tabIndex={0}
                  onClick={clear}
                  aria-label={clearLabel}
                  initial={
                    reduced
                      ? { opacity: 0 }
                      : {
                          opacity: 0,
                          scale: 0.8,
                          filter: `blur(${motionTokens.blur.subtle}px)`,
                        }
                  }
                  animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
                  exit={
                    reduced
                      ? { opacity: 0, transition: { duration: 0 } }
                      : {
                          opacity: 0,
                          scale: 0.8,
                          filter: `blur(${motionTokens.blur.subtle}px)`,
                          transition: {
                            duration: motionTokens.duration.instant,
                            ease: [...motionTokens.ease.standard],
                          },
                        }
                  }
                  whileTap={
                    reduced
                      ? undefined
                      : {
                          scale: 0.96,
                          transition: {
                            duration: motionTokens.duration.instant,
                            ease: [...motionTokens.ease.standard],
                          },
                        }
                  }
                  transition={
                    reduced
                      ? { duration: motionTokens.duration.instant }
                      : {
                          ...motionTokens.spring.snappy,
                          opacity: { duration: motionTokens.duration.fast },
                          filter: { duration: motionTokens.duration.fast },
                        }
                  }
                >
                  <Xmark width={16} height={16} aria-hidden="true" />
                </ClearControl>
              ) : null}
            </AnimatePresence>
          </span>
        </div>
      </div>
    );
  },
);
