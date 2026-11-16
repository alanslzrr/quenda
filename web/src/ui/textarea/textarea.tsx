"use client";

import { forwardRef, useId } from "react";
import type { TextareaHTMLAttributes } from "react";
import { FieldMessage } from "../lib/field-message";
import styles from "./textarea.module.css";

export interface TextareaProps
  extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  description?: string;
  error?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea(
    { label, description, error, id, className, ...props },
    ref,
  ) {
    const generatedId = useId();
    const controlId = id ?? generatedId;
    const hintId = description ? `${controlId}-description` : undefined;
    const errorId = error ? `${controlId}-error` : undefined;
    return (
      <div className={styles.field}>
        <label htmlFor={controlId}>{label}</label>
        <textarea
          {...props}
          data-lumen-border-focus=""
          id={controlId}
          ref={ref}
          className={[styles.control, className].filter(Boolean).join(" ")}
          aria-invalid={error ? true : props["aria-invalid"]}
          aria-describedby={
            [props["aria-describedby"], hintId, errorId]
              .filter(Boolean)
              .join(" ") || undefined
          }
        />
        <FieldMessage id={hintId} text={description} className={styles.hint} />
        <FieldMessage id={errorId} text={error} className={styles.error} />
      </div>
    );
  },
);

Textarea.displayName = "Textarea";
