type NativeField = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/**
 * Radix validates a required checkbox or select through a hidden native mirror (aria-hidden, tabIndex -1) rendered right
 * after its visible button. The mirror cannot take focus or show a bubble, so the button stands in for it.
 */
function mirroredControl(target: EventTarget | null) {
  if (
    !(
      target instanceof HTMLSelectElement || target instanceof HTMLInputElement
    ) ||
    target.getAttribute("aria-hidden") !== "true"
  )
    return null;
  for (
    let node = target.previousElementSibling;
    node;
    node = node.previousElementSibling
  )
    if (
      node instanceof HTMLButtonElement &&
      node.matches('[role="checkbox"], [role="combobox"]')
    )
      return node;
  return null;
}

const nativeField = (target: EventTarget | null): target is NativeField =>
  (target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement) &&
  target.willValidate &&
  target.getAttribute("aria-hidden") !== "true";

/**
 * Keeps a form's failed constraints perceivable. `:user-invalid` styles a native field only after interaction, but it is
 * not exposed to assistive tech, so aria-invalid follows it here. On a failed submit the first invalid field receives
 * focus, also when it is a Radix control whose own field shows the error. Pass it as the form's ref.
 */
export function trackValidity(form: HTMLFormElement | null) {
  if (!form) return;
  let edited = new WeakSet<Element>();
  let flagged = new WeakSet<Element>();
  // Set while the browser fires `invalid` on each failing field of one submit attempt.
  let pass: { focus?: HTMLButtonElement } | undefined;
  const sync = (field: NativeField) => {
    if (!field.validity.valid) {
      // An aria-invalid the caller set for an explicit error is theirs: it is neither duplicated nor removed.
      if (field.getAttribute("aria-invalid") === "true") return;
      field.setAttribute("aria-invalid", "true");
      flagged.add(field);
    } else if (flagged.has(field)) {
      field.removeAttribute("aria-invalid");
      flagged.delete(field);
    }
  };
  const onInvalid = (event: Event) => {
    const first = !pass;
    if (!pass) {
      const current: { focus?: HTMLButtonElement } = {};
      pass = current;
      // The pass ends once every field has been checked; by then the Radix field has rendered its error.
      window.setTimeout(() => {
        pass = undefined;
        current.focus?.focus();
      });
    }
    const control = mirroredControl(event.target);
    if (control) {
      event.preventDefault();
      if (first) pass.focus = control;
      return;
    }
    // A Radix control earlier in the form takes the focus, so the browser must not move it to this field.
    if (pass.focus) event.preventDefault();
    if (nativeField(event.target)) {
      edited.add(event.target);
      sync(event.target);
    }
  };
  const onInput = (event: Event) => {
    if (!nativeField(event.target)) return;
    edited.add(event.target);
    // A flagged field clears as soon as it is fixed; a new error waits for blur.
    if (flagged.has(event.target)) sync(event.target);
  };
  const onChange = (event: Event) => {
    if (!nativeField(event.target)) return;
    edited.add(event.target);
    sync(event.target);
  };
  const onBlur = (event: Event) => {
    if (nativeField(event.target) && edited.has(event.target))
      sync(event.target);
  };
  const onReset = () => {
    for (const field of form.elements)
      if (flagged.has(field)) field.removeAttribute("aria-invalid");
    edited = new WeakSet();
    flagged = new WeakSet();
  };
  // `invalid` does not bubble, so the form listens in the capture phase.
  form.addEventListener("invalid", onInvalid, true);
  form.addEventListener("input", onInput);
  form.addEventListener("change", onChange);
  form.addEventListener("focusout", onBlur);
  form.addEventListener("reset", onReset);
  return () => {
    form.removeEventListener("invalid", onInvalid, true);
    form.removeEventListener("input", onInput);
    form.removeEventListener("change", onChange);
    form.removeEventListener("focusout", onBlur);
    form.removeEventListener("reset", onReset);
  };
}
