import {
  Children,
  type FormEvent,
  type ReactNode,
  useEffect,
  useId,
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
}) {
  const lock = useRef(false);
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
      ref={trackValidity}
      className={styles.form}
      onSubmit={run}
      aria-busy={busy || undefined}
    >
      {Children.toArray(children).length > 0 && (
        <fieldset className={styles.fields}>{children}</fieldset>
      )}
      {error !== undefined && <Failure error={error} />}
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
