import {
  Children,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Alert } from "../ui/alert/alert";
import { Button } from "../ui/button/button";
import { announce } from "./announce";
import { ApiError } from "./api";
import { Failure } from "./feedback";
import styles from "./layout.module.css";
import { clearFields, trackValidity } from "./validity";

const enabled = (element: Element | null | undefined) =>
  element instanceof HTMLElement &&
  !element.matches(":disabled, [aria-hidden='true'], [tabindex='-1']")
    ? element
    : undefined;

/**
 * Where the person continues after a form was rebuilt under them: the first field (consent given for the previous
 * state starts over), else the submit button, else any other action, else the failure that explains why the form
 * changed.
 */
function retryTarget(form: HTMLFormElement, failure: HTMLElement | null) {
  const fields = form.querySelector(":scope > fieldset");
  const controls = (root: Element | null | undefined) =>
    root
      ? [
          ...root.querySelectorAll(
            "input:not([type='hidden']), select, textarea, button, a[href], [tabindex]",
          ),
        ]
          .map(enabled)
          .find(Boolean)
      : undefined;
  return (
    controls(fields) ??
    enabled(form.querySelector("button[type='submit']")) ??
    controls(form) ??
    failure ??
    undefined
  );
}

// Mutations are explicit, single-flight and never retried by the component.
export function ActionForm({
  children,
  submit,
  label,
  success,
  danger = false,
  quiet = false,
  resetOnSuccess = true,
  clearOnSuccess = [],
  disabled = false,
  unavailable,
  secondary,
  initialError,
  focusOnMount = false,
}: {
  children?: ReactNode;
  secondary?: ReactNode;
  submit: (data: FormData) => Promise<void>;
  label: string;
  success?: string;
  danger?: boolean;
  /** A destructive action repeated on many rows: red text instead of a bordered button. */
  quiet?: boolean;
  resetOnSuccess?: boolean;
  /** Fields to empty after success when the rest of the form must stay as edited, such as a one-off reason. */
  clearOnSuccess?: string[];
  disabled?: boolean;
  /** Why the action cannot run yet; disables submission and is shown next to the button. */
  unavailable?: string;
  /**
   * A failure to show when the form mounts: an owner that rebuilds the form for refreshed data passes the failure
   * that caused the refresh, so the person still sees why their submission did not go through.
   */
  initialError?: unknown;
  /**
   * The form replaces one that its owner rebuilt after a failed submission: if the keyboard focus fell to the page
   * with the old form, it moves to where the person continues. Focus that is elsewhere is never taken.
   */
  focusOnMount?: boolean;
}) {
  const lock = useRef(false);
  const formElement = useRef<HTMLFormElement | null>(null);
  const failureElement = useRef<HTMLDivElement>(null);
  const formRef = useCallback((form: HTMLFormElement | null) => {
    formElement.current = form;
    return trackValidity(form);
  }, []);
  const reasonId = useId();
  const blocked = disabled || !!unavailable;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(initialError);
  const [done, setDone] = useState(false);
  // A failure carried into a new form is shown together with it, which a live region does not announce reliably.
  const carried = useRef(initialError);
  useEffect(() => {
    if (carried.current instanceof ApiError) announce(carried.current.message);
  }, []);
  // Before paint and before a dialog's focus trap reacts to the removed control, so focus never rests on the page.
  const refocus = useRef(focusOnMount);
  useLayoutEffect(() => {
    const form = formElement.current;
    if (!refocus.current || !form) return;
    const active = document.activeElement;
    if (active && active !== document.body && !active.contains(form)) return;
    retryTarget(form, failureElement.current)?.focus();
  }, []);
  // The page announcer speaks the outcome once it is shown: a live region mounted together with its text is not
  // announced reliably. A form that unmounted meanwhile (its owner moved on) leaves the outcome to its owner.
  useEffect(() => {
    if (done && success) announce(success);
  }, [done, success]);
  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lock.current || blocked) return;
    lock.current = true;
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError(undefined);
    setDone(false);
    try {
      await submit(data);
      setDone(true);
      if (resetOnSuccess) form.reset();
      else clearFields(form, clearOnSuccess);
    } catch (failure) {
      setError(failure);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    // Busy fields stay enabled: disabling them would drop keyboard focus to the page mid-submit, and the lock already rejects a resubmit.
    <form
      ref={formRef}
      className={styles.form}
      onSubmit={run}
      aria-busy={busy || undefined}
    >
      {Children.toArray(children).length > 0 && (
        <fieldset className={styles.fields}>{children}</fieldset>
      )}
      {error !== undefined && (
        // Focusable only from code, as the last place to continue when the rebuilt form offers no control.
        <div ref={failureElement} tabIndex={-1}>
          <Failure error={error} />
        </div>
      )}
      {done && success && <Alert tone="success" title={success} role="none" />}
      {unavailable && <p id={reasonId}>{unavailable}</p>}
      {secondary ? (
        <div className={styles.formActions}>
          {secondary}
          <Button
            type="submit"
            variant={danger ? (quiet ? "danger-ghost" : "danger") : "primary"}
            loading={busy}
            disabled={blocked}
            aria-describedby={unavailable ? reasonId : undefined}
          >
            {label}
          </Button>
        </div>
      ) : (
        <Button
          type="submit"
          variant={danger ? (quiet ? "danger-ghost" : "danger") : "primary"}
          loading={busy}
          disabled={blocked}
          aria-describedby={unavailable ? reasonId : undefined}
        >
          {label}
        </Button>
      )}
    </form>
  );
}
export const textField = (data: FormData, name: string) =>
  String(data.get(name) ?? "");
