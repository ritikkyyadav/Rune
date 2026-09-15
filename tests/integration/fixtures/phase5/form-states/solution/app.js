// The contact form. The pure halves — validation and markup — are exported so
// they can be exercised without a DOM; `mount` is the only part that touches
// one.

import { FIELDS } from "./fields.js";

const DRAFT_KEY = "fieldnotes.contact.draft";

/** Errors by field name. An empty object means the values are valid. */
export function validate(values) {
  const errors = {};
  for (const field of FIELDS) {
    const raw = String(values?.[field.name] ?? "").trim();
    if (field.required && !raw) {
      errors[field.name] = `${field.label} is required.`;
      continue;
    }
    if (field.type === "email" && raw && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
      errors[field.name] = "That email address does not look right.";
      continue;
    }
    if (field.min && raw.length < field.min) {
      errors[field.name] = `${field.label} needs at least ${field.min} characters.`;
    }
  }
  return errors;
}

/**
 * The form as markup, for one state. Four states exist and each says what
 * happened and what to do next: empty (nothing typed yet), error (the submit
 * was refused), sending, sent.
 */
export function renderForm(state = {}) {
  const values = state.values ?? {};
  const errors = state.errors ?? {};
  const touched = Object.values(values).some((v) => String(v ?? "").trim());
  const mode =
    state.mode ?? (Object.keys(errors).length > 0 ? "error" : touched ? "idle" : "empty");

  const fields = FIELDS.map((field) => {
    const id = `f-${field.name}`;
    const error = errors[field.name];
    const described = error ? ` aria-describedby="${id}-error"` : "";
    const invalid = error ? ' aria-invalid="true"' : "";
    const value = String(values[field.name] ?? "");
    const control =
      field.type === "textarea"
        ? `<textarea id="${id}" name="${field.name}"${invalid}${described}>${value}</textarea>`
        : `<input id="${id}" name="${field.name}" type="${field.type}" value="${value}"${invalid}${described} />`;
    return [
      `<div class="field">`,
      `<label for="${id}">${field.label}</label>`,
      control,
      error ? `<p class="field-error" id="${id}-error">${error}</p>` : "",
      `</div>`,
    ].join("");
  }).join("");

  const banner =
    mode === "error"
      ? `<p class="banner" role="alert" data-state="error">We could not send that yet — fix the fields marked below.</p>`
      : mode === "sending"
        ? `<p class="banner" data-state="sending">Sending your message…</p>`
        : mode === "sent"
          ? `<p class="banner" role="status" data-state="sent">Thank you — we will reply within two working days.</p>`
          : mode === "empty"
            ? `<p class="banner" data-state="empty">Nothing typed yet. Tell us what you need and we will reply within two working days.</p>`
            : "";

  return [
    `<form class="contact" data-state="${mode}" novalidate>`,
    `<h1>Get in touch</h1>`,
    banner,
    fields,
    `<button type="submit">Send message</button>`,
    `</form>`,
  ].join("");
}

/** The draft, so a reload does not lose what someone typed. */
export function saveDraft(values, storage = globalThis.localStorage) {
  try {
    storage?.setItem(DRAFT_KEY, JSON.stringify(values ?? {}));
  } catch {
    /* storage can be unavailable; the form still works */
  }
}

export function loadDraft(storage = globalThis.localStorage) {
  try {
    return JSON.parse(storage?.getItem(DRAFT_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

export function mount(root) {
  let values = loadDraft();
  let errors = {};
  let mode = Object.keys(values).length > 0 ? "idle" : "empty";

  const paint = () => {
    root.innerHTML = renderForm({ values, errors, mode });
    const form = root.querySelector("form");
    form.addEventListener("input", (event) => {
      values = { ...values, [event.target.name]: event.target.value };
      saveDraft(values);
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      errors = validate(values);
      if (Object.keys(errors).length > 0) {
        mode = "error";
        paint();
        // Keyboard flow: the first thing wrong is where the caret goes.
        root.querySelector('[aria-invalid="true"]')?.focus();
        return;
      }
      mode = "sent";
      paint();
      root.querySelector(".banner")?.focus?.();
    });
  };

  paint();
}
