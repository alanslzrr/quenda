import { type FormEvent, type ReactNode, useRef, useState } from "react";
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
}: {
  children?: ReactNode;
  submit: (data: FormData) => Promise<void>;
  label: string;
  success?: string;
  danger?: boolean;
}) {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [done, setDone] = useState(false);
  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lock.current) return;
    lock.current = true;
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError(undefined);
    setDone(false);
    try {
      await submit(data);
      setDone(true);
      form.reset();
    } catch (failure) {
      setError(failure);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <form className={styles.form} onSubmit={run}>
      <fieldset disabled={busy} className={styles.fields}>
        {children}
      </fieldset>
      {error !== undefined && <Failure error={error} />}
      {done && success && (
        <div role="status">
          <Alert tone="success" title={success} />
        </div>
      )}
      <Button
        type="submit"
        variant={danger ? "danger" : "primary"}
        loading={busy}
        disabled={busy}
      >
        {label}
      </Button>
    </form>
  );
}
export const textField = (data: FormData, name: string) =>
  String(data.get(name) ?? "");
