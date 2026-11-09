import {
  Children,
  type FormEvent,
  type ReactNode,
  useRef,
  useState,
} from "react";
import { Alert } from "../ui/alert/alert";
import { Button } from "../ui/button/button";
import { Failure } from "./feedback";
import styles from "./layout.module.css";

// Mutations are explicit, single-flight and never retried by the component.
export function ActionForm({
  children,
  submit,
  label,
  success,
  danger = false,
  resetOnSuccess = true,
  clearOnSuccess = [],
  disabled = false,
  secondary,
}: {
  children?: ReactNode;
  secondary?: ReactNode;
  submit: (data: FormData) => Promise<void>;
  label: string;
  success?: string;
  danger?: boolean;
  resetOnSuccess?: boolean;
  /** Fields to empty after success when the rest of the form must stay as edited, such as a one-off reason. */
  clearOnSuccess?: string[];
  disabled?: boolean;
}) {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [done, setDone] = useState(false);
  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lock.current || disabled) return;
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
      else
        for (const name of clearOnSuccess) {
          const field = form.elements.namedItem(name);
          if (field instanceof HTMLInputElement) field.value = "";
        }
    } catch (failure) {
      setError(failure);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <form className={styles.form} onSubmit={run}>
      {Children.toArray(children).length > 0 && (
        <fieldset disabled={busy} className={styles.fields}>
          {children}
        </fieldset>
      )}
      {error !== undefined && <Failure error={error} />}
      {done && success && (
        <div role="status">
          <Alert tone="success" title={success} />
        </div>
      )}
      {secondary ? (
        <div className={styles.formActions}>
          {secondary}
          <Button
            type="submit"
            variant={danger ? "danger" : "primary"}
            loading={busy}
            disabled={busy || disabled}
          >
            {label}
          </Button>
        </div>
      ) : (
        <Button
          type="submit"
          variant={danger ? "danger" : "primary"}
          loading={busy}
          disabled={busy || disabled}
        >
          {label}
        </Button>
      )}
    </form>
  );
}
export const textField = (data: FormData, name: string) =>
  String(data.get(name) ?? "");
