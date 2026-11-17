"use client";

import {
  animate,
  AnimatePresence,
  motion,
  useIsPresent,
  useReducedMotion,
} from "motion/react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  InputHTMLAttributes,
  CompositionEvent,
  KeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  RefObject,
} from "react";
import {
  anchorStyle,
  topLayerProps,
  useAnchorName,
  useTopLayerRef,
} from "../lib/anchored-popover";
import { pickText } from "../lib/locale-text";
import { motionTokens } from "../motion-tokens";
import { filterOptions, orderedOptions, sectionOptions, type ComboboxOption } from "./filter";
import styles from "./combobox.module.css";

export type { ComboboxOption } from "./filter";

/** Choose one option by typing part of its name, its group or a keyword; options with a `group` are listed under visible headings. */
export interface ComboboxProps
  extends Omit<
    InputHTMLAttributes<HTMLInputElement>,
    "value" | "defaultValue" | "onChange" | "placeholder"
  > {
  label: string;
  options: ComboboxOption[];
  /** Galician (gl) or Spanish (es) built-in copy; any other locale falls back to English. */
  locale: string;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  description?: string;
  /** Defaults to a localised "Search or choose…". */
  placeholder?: string;
  /** Defaults to a localised "No results". */
  emptyMessage?: string;
  className?: string;
}

const comboboxText = (locale: string) => {
  const text = <T,>(gl: T, es: T, en: T) => pickText(locale, { gl, es, en });
  return {
    placeholder: text("Busca ou escolle…", "Busca o elige…", "Search or select…"),
    empty: text("Sen resultados", "Sin resultados", "No results"),
    clear: text("Borrar a selección", "Borrar la selección", "Clear selection"),
    options: (label: string) => text(`${label}: opcións`, `${label}: opciones`, `${label} options`),
  };
};

/** Follows the listbox height with a critically damped spring, so filtering never snaps the menu. */
function AutoHeight({
  children,
  reduceMotion,
}: {
  children: ReactNode;
  reduceMotion: boolean | null;
}) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | "auto">("auto");
  useEffect(() => {
    const inner = innerRef.current;
    if (!inner || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(inner.offsetHeight));
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);
  return (
    <motion.div
      className={styles.autoHeight}
      initial={false}
      animate={{ height }}
      transition={reduceMotion ? { duration: 0 } : motionTokens.spring.smooth}
    >
      <div ref={innerRef}>{children}</div>
    </motion.div>
  );
}

function Popover({ children, reduceMotion, anchor, anchorRef }: { children: ReactNode; reduceMotion: boolean | null; anchor: string; anchorRef: RefObject<HTMLDivElement | null> }) {
  const present = useIsPresent();
  const ref = useTopLayerRef<HTMLDivElement>(undefined, anchorRef);
  const layer = topLayerProps(anchor);
  return (
    <motion.div
      {...layer}
      ref={ref}
      className={styles.popover}
      aria-hidden={!present || undefined}
      inert={!present || undefined}
      style={{ ...("style" in layer ? layer.style : {}), ...(!present ? { pointerEvents: "none" } : {}) }}
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1, transition: reduceMotion ? { duration: motionTokens.duration.instant } : { ...motionTokens.spring.snappy, opacity: { duration: motionTokens.duration.fast, ease: [...motionTokens.ease.enter] } } }}
      exit={{ opacity: 0, ...(reduceMotion ? {} : { y: -4, scale: 0.98 }), transition: { duration: motionTokens.duration.instant, ease: [...motionTokens.ease.standard] } }}
      role="presentation"
    >{children}</motion.div>
  );
}

function ClearButton({ label, onClear, reduceMotion }: { label: string; onClear: (event: ReactMouseEvent<HTMLButtonElement>) => void; reduceMotion: boolean | null }) {
  const present = useIsPresent();
  return (
    <motion.button
      type="button"
      className={styles.clear}
      aria-label={label}
      aria-hidden={!present || undefined}
      inert={!present || undefined}
      tabIndex={present ? undefined : -1}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => { if (present) onClear(event); }}
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.6, filter: `blur(${motionTokens.blur.subtle}px)` }}
      animate={{ opacity: 1, scale: 1, filter: "blur(0px)", transition: reduceMotion ? { duration: motionTokens.duration.instant } : { ...motionTokens.spring.snappy, opacity: { duration: motionTokens.duration.fast } } }}
      exit={{ opacity: 0, ...(reduceMotion ? {} : { scale: 0.6, filter: `blur(${motionTokens.blur.subtle}px)` }), transition: { duration: motionTokens.duration.instant, ease: [...motionTokens.ease.standard] } }}
      whileTap={{ scale: reduceMotion ? 1 : 0.96, transition: { duration: motionTokens.duration.instant, ease: [...motionTokens.ease.standard] } }}
    ><X size={16} strokeWidth={1.75} aria-hidden="true" /></motion.button>
  );
}

export const Combobox = forwardRef<HTMLInputElement, ComboboxProps>(
  function Combobox(
    {
      label,
      options,
      locale,
      value: controlledValue,
      defaultValue = "",
      onValueChange,
      description,
      placeholder: placeholderProp,
      emptyMessage: emptyMessageProp,
      id,
      className,
      disabled,
      onFocus,
      onBlur,
      onClick,
      onKeyDown,
      onInput,
      onCompositionStart,
      onCompositionEnd,
      "aria-describedby": describedBy,
      ...inputProps
    },
    forwardedRef,
  ) {
    const text = useMemo(() => comboboxText(locale), [locale]);
    const placeholder = placeholderProp ?? text.placeholder;
    const emptyMessage = emptyMessageProp ?? text.empty;
    const generatedId = useId();
    const controlId = id ?? generatedId;
    const listboxId = `${controlId}-listbox`;
    const hintId = description ? `${controlId}-description` : undefined;
    const rootRef = useRef<HTMLDivElement>(null);
    const anchor = useAnchorName();
    const controlRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const composing = useRef(false);
    // A pointer that focuses the field selects its text on release: the release would otherwise collapse the selection.
    const selectOnPointerUp = useRef(false);
    const resetRevision = useRef(0);
    const lastControlledValue = useRef(controlledValue);
    const optionRefs = useRef<Record<string, HTMLDivElement | null>>({});
    const reduceMotion = useReducedMotion();
    const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue);
    const [requestedOpen, setOpen] = useState(false);
    const open = requestedOpen && !disabled;
    // Null until the user types after opening: the field keeps showing the chosen label, and the list is unfiltered.
    const [query, setQuery] = useState<string | null>(null);
    const [activeValue, setActiveValue] = useState<string | null>(null);
    // Exit animations can retain old option handlers; actions validate current props.
    const actions = useRef({ disabled, options, onValueChange, open });
    useLayoutEffect(() => { actions.current = { disabled, options, onValueChange, open }; });
    useEffect(() => {
      if (disabled) { setOpen(false); setQuery(null); setActiveValue(null); }
    }, [disabled]);
    const selectedValue = controlledValue ?? uncontrolledValue;
    const selectedOption = options.find(
      (option) => option.value === selectedValue,
    );

    useImperativeHandle(
      forwardedRef,
      () => inputRef.current as HTMLInputElement,
    );

    // A chosen label settles into the field: it rises in from below with a soft blur. Clearing fades the
    // placeholder in instead of snapping from the old label.
    const settledValue = useRef(selectedValue);
    useEffect(() => {
      if (settledValue.current === selectedValue) return;
      settledValue.current = selectedValue;
      const input = inputRef.current;
      if (!input || reduceMotion || (selectedValue && open)) return;
      const controls = selectedValue
        ? animate(
            input,
            {
              opacity: [0, 1],
              y: ["0.35em", "0em"],
              filter: [`blur(${motionTokens.blur.soft}px)`, "blur(0px)"],
            },
            {
              duration: motionTokens.duration.standard,
              ease: [...motionTokens.ease.enter],
            },
          )
        : animate(
            input,
            { opacity: [0, 1] },
            {
              duration: motionTokens.duration.fast,
              ease: [...motionTokens.ease.enter],
            },
          );
      return () => controls.complete();
    }, [selectedValue, reduceMotion, open]);

    // Grouped options are listed, and stepped through with the arrow keys, under their headings.
    const sections = useMemo(() => sectionOptions(filterOptions(options, query ?? "")), [options, query]);
    const filteredOptions = useMemo(() => orderedOptions(sections), [sections]);

    const activeIndex = filteredOptions.findIndex(option => option.value === activeValue && !option.disabled);
    const setActiveIndex = (index: number) => setActiveValue(filteredOptions[index]?.value ?? null);
    useEffect(() => {
      if (activeValue !== null && activeIndex < 0) setActiveValue(null);
    }, [activeValue, activeIndex]);

    const enabledIndices = filteredOptions.reduce<number[]>(
      (indices, option, index) => {
        if (!option.disabled) indices.push(index);
        return indices;
      },
      [],
    );

    useEffect(() => {
      if (!open) return;
      const activeOption =
        activeIndex >= 0 ? filteredOptions[activeIndex] : undefined;
      const option = activeOption
        ? optionRefs.current[activeOption.value]
        : null;
      // Options may sit inside a group, so measure against the listbox rather than the direct parent.
      const listbox = option?.closest<HTMLElement>('[role="listbox"]');
      if (option && listbox) {
        const top = option.getBoundingClientRect().top - listbox.getBoundingClientRect().top + listbox.scrollTop;
        const bottom = top + option.offsetHeight;
        if (top < listbox.scrollTop) listbox.scrollTop = top;
        else if (bottom > listbox.scrollTop + listbox.clientHeight)
          listbox.scrollTop = bottom - listbox.clientHeight;
      }
    }, [activeIndex, filteredOptions, open]);

    useEffect(() => {
      const handlePointerDown = (event: PointerEvent) => {
        if (
          rootRef.current &&
          !rootRef.current.contains(event.target as Node)
        ) {
          setOpen(false);
          setQuery(null);
        }
      };
      document.addEventListener("pointerdown", handlePointerDown);
      return () =>
        document.removeEventListener("pointerdown", handlePointerDown);
    }, []);

    const choose = (option: ComboboxOption) => {
      const latest = actions.current;
      const available = latest.options.find(item => item.value === option.value);
      if (latest.disabled || !latest.open || !available || available.disabled) return;
      resetRevision.current++;
      setUncontrolledValue(option.value);
      latest.onValueChange?.(option.value);
      setQuery(null);
      setOpen(false);
      inputRef.current?.focus();
    };

    const clear = (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      if (actions.current.disabled) return;
      resetRevision.current++;
      setUncontrolledValue("");
      actions.current.onValueChange?.("");
      setQuery(null);
      setOpen(true);
      inputRef.current?.focus();
    };

    const openMenu = () => {
      if (disabled) return;
      setOpen(true);
      setQuery(null);
      setActiveIndex(-1);
      // The whole label is selected, so typing replaces it and filtering starts from the typed text.
      inputRef.current?.select();
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
      onKeyDown?.(event);
      if (event.defaultPrevented || disabled || composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!open) {
          openMenu();
          return;
        }
        if (!enabledIndices.length) return;
        const currentPosition = enabledIndices.indexOf(activeIndex);
        const nextPosition = currentPosition < 0
          ? (event.key === "ArrowDown" ? 0 : enabledIndices.length - 1)
          : event.key === "ArrowDown"
            ? (currentPosition + 1) % enabledIndices.length
            : (currentPosition - 1 + enabledIndices.length) %
              enabledIndices.length;
        setActiveIndex(enabledIndices[nextPosition] ?? -1);
        return;
      }
      if (event.key === "Enter" && open && activeIndex >= 0) {
        event.preventDefault();
        const option = filteredOptions[activeIndex];
        if (option) choose(option);
        return;
      }
      if (event.key === "Escape" && open) {
        event.preventDefault();
        setOpen(false);
        setQuery(null);
        return;
      }
    };

    // Escape or leaving without choosing drops the typed text, so the chosen label comes back.
    const inputValue =
      open && query !== null ? query : (selectedOption?.label ?? "");
    const activeOption =
      activeIndex >= 0 ? filteredOptions[activeIndex] : undefined;
    const resetState = useRef({
      selectedValue,
      defaultValue,
      controlled: controlledValue !== undefined,
      onValueChange,
    });
    useLayoutEffect(() => {
      if (lastControlledValue.current !== controlledValue) {
        lastControlledValue.current = controlledValue;
        resetRevision.current++;
      }
      resetState.current = {
        selectedValue,
        defaultValue,
        controlled: controlledValue !== undefined,
        onValueChange,
      };
      const input = inputRef.current;
      if (input) {
        input.defaultValue =
          controlledValue !== undefined
            ? inputValue
            : options.find((option) => option.value === defaultValue)?.label ?? "";
      }
    });
    // biome-ignore lint/correctness/useExhaustiveDependencies: A new form attribute moves the input to another form, whose reset must be followed instead.
    useEffect(() => {
      const form = inputRef.current?.form;
      if (!form) return;
      let active = true;
      const onReset = (event: Event) => {
        const atReset = resetRevision.current;
        window.setTimeout(() => {
          if (
            !active ||
            event.defaultPrevented ||
            resetRevision.current !== atReset
          ) return;
          const state = resetState.current;
          if (state.controlled) return;
          // Native reset does not emit an input event. Synchronize React's
          // value tracker before the next edit, even when the DOM already
          // matches the reset value.
          const input = inputRef.current;
          if (input) {
            const current = input.value;
            input.value = current;
          }
          resetRevision.current++;
          setUncontrolledValue(state.defaultValue);
          setQuery(null);
          setOpen(false);
          setActiveValue(null);
          composing.current = false;
          if (state.selectedValue !== state.defaultValue) {
            state.onValueChange?.(state.defaultValue);
          }
        }, 0);
      };
      form.addEventListener("reset", onReset);
      return () => {
        active = false;
        form.removeEventListener("reset", onReset);
      };
    }, [inputProps.form]);

    return (
      <div ref={rootRef} className={styles.field}>
        <label htmlFor={controlId}>{label}</label>
        <div
          ref={controlRef}
          style={anchorStyle(anchor)}
          className={[
            styles.control,
            open ? styles.open : "",
            disabled ? styles.disabled : "",
            className ?? "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          <Search
            className={styles.searchIcon}
            size={16}
            strokeWidth={1.75}
            aria-hidden="true"
          />
          <input
            data-border-focus=""
            {...inputProps}
            ref={inputRef}
            id={controlId}
            type="text"
            role="combobox"
            value={inputValue}
            // A placeholder is not a lasting label, so the chosen label stays as the value and this is only a prompt.
            placeholder={placeholder}
            disabled={disabled}
            aria-describedby={[describedBy, hintId].filter(Boolean).join(" ") || undefined}
            aria-expanded={open}
            aria-controls={open && filteredOptions.length ? listboxId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={
              open && activeOption
                ? `${controlId}-option-${activeIndex}`
                : undefined
            }
            onFocus={(event) => {
              onFocus?.(event);
              openMenu();
            }}
            onMouseDown={(event) => {
              inputProps.onMouseDown?.(event);
              selectOnPointerUp.current = document.activeElement !== event.currentTarget;
            }}
            onMouseUp={(event) => {
              inputProps.onMouseUp?.(event);
              if (!selectOnPointerUp.current) return;
              selectOnPointerUp.current = false;
              event.preventDefault();
              event.currentTarget.select();
            }}
            onClick={(event) => {
              onClick?.(event);
              if (!event.defaultPrevented && !open) openMenu();
            }}
            onCompositionStart={(event: CompositionEvent<HTMLInputElement>) => {
              composing.current = true;
              onCompositionStart?.(event);
            }}
            onCompositionEnd={(event: CompositionEvent<HTMLInputElement>) => {
              composing.current = false;
              onCompositionEnd?.(event);
            }}
            onBlur={(event) => {
              composing.current = false;
              setOpen(false);
              setQuery(null);
              setActiveValue(null);
              onBlur?.(event);
            }}
            onInput={(event) => {
              // Native reset can leave React's change tracker behind the DOM.
              // Capture input events directly so an identical later edit is kept.
              const next = event.currentTarget.value;
              onInput?.(event);
              resetRevision.current++;
              setQuery(next);
              setOpen(true);
              setActiveIndex(-1);
            }}
            onKeyDown={handleKeyDown}
          />
          <AnimatePresence initial={false}>
            {selectedOption && !disabled && (
              <ClearButton label={text.clear} onClear={clear} reduceMotion={reduceMotion} />
            )}
          </AnimatePresence>
          <ChevronDown
            className={styles.chevron}
            size={16}
            strokeWidth={1.75}
            aria-hidden="true"
          />
        </div>
        {description && (
          <span id={hintId} className={styles.hint}>
            {description}
          </span>
        )}
        <AnimatePresence initial={false}>
          {open && (
            <Popover reduceMotion={reduceMotion} anchor={anchor} anchorRef={controlRef}>
              <AutoHeight reduceMotion={reduceMotion}>
                {filteredOptions.length ? (
                  <div
                    id={listboxId}
                    className={styles.listbox}
                    role="listbox"
                    aria-label={text.options(label)}
                  >
                    {sections.map((section, sectionIndex) => {
                      const items = section.options.map(({ option, index }) => (
                        // biome-ignore lint/a11y/useFocusableInteractive lint/a11y/useKeyWithClickEvents: Options stay in the input's focus through aria-activedescendant; the input handles the keys.
                        <div
                          key={option.value}
                          ref={(element) => {
                            optionRefs.current[option.value] = element;
                          }}
                          id={`${controlId}-option-${index}`}
                          className={styles.option}
                          data-active={index === activeIndex ? "true" : undefined}
                          data-disabled={option.disabled ? "true" : undefined}
                          role="option"
                          aria-selected={option.value === selectedValue}
                          aria-disabled={option.disabled || undefined}
                          onMouseDown={(event) => event.preventDefault()}
                          onMouseEnter={() =>
                            !option.disabled && setActiveIndex(index)
                          }
                          onClick={() => choose(option)}
                        >
                          <span className={styles.optionText}>
                            <span className={styles.optionLabel}>{option.label}</span>
                            {option.hint && (
                              <>
                                <span className={styles.srOnly}>, </span>
                                <span className={styles.optionHint}>{option.hint}</span>
                              </>
                            )}
                          </span>
                          {option.value === selectedValue && (
                            <Check
                              className={styles.check}
                              size={16}
                              strokeWidth={1.75}
                              aria-hidden="true"
                            />
                          )}
                        </div>
                      ));
                      if (section.group === undefined) return items;
                      const headingId = `${controlId}-group-${sectionIndex}`;
                      return (
                        // biome-ignore lint/a11y/useSemanticElements: A listbox option group; a fieldset is not allowed inside a listbox.
                        <div key={`group:${section.group}`} role="group" aria-labelledby={headingId} className={styles.group}>
                          <div id={headingId} role="presentation" className={styles.groupLabel}>
                            {section.group}
                          </div>
                          {items}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <motion.div
                    className={styles.empty}
                    aria-hidden="true"
                    initial={
                      reduceMotion
                        ? false
                        : {
                            opacity: 0,
                            y: 4,
                            filter: `blur(${motionTokens.blur.soft}px)`,
                          }
                    }
                    animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                    transition={{
                      duration: motionTokens.duration.standard,
                      ease: [...motionTokens.ease.enter],
                    }}
                  >
                    {emptyMessage}
                  </motion.div>
                )}
              </AutoHeight>
            </Popover>
          )}
        </AnimatePresence>
        {/* A lasting live region, so "no results" is announced even though the visible copy mounts with the popover. */}
        <span className={styles.srOnly} role="status">
          {open && !filteredOptions.length ? emptyMessage : ""}
        </span>
      </div>
    );
  },
);

Combobox.displayName = "Combobox";
