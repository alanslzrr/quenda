"use client";

import { forwardRef, useId } from "react";
import type { InputHTMLAttributes } from "react";
import { FieldMessage } from "../lib/field-message";
import styles from "./input.module.css";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  description?: string;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, description, error, id, className, ...props },
  ref,
) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const hintId = description ? `${controlId}-description` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy =
    [props["aria-describedby"], hintId, errorId].filter(Boolean).join(" ") ||
    undefined;
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={controlId}>
        {label}
      </label>
      <input
        {...props}
        data-lumen-border-focus=""
        id={controlId}
        ref={ref}
        className={[styles.input, className].filter(Boolean).join(" ")}
        aria-invalid={error ? true : props["aria-invalid"]}
        aria-describedby={describedBy}
      />
      <FieldMessage
        id={hintId}
        text={description}
        className={styles.description}
      />
      <FieldMessage id={errorId} text={error} className={styles.error} alert />
    </div>
  );
});

Input.displayName = "Input";
