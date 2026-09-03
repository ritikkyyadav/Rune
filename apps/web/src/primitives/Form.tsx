// ─── Form — structured input the agent needs before it can go on ───
//
// Four field kinds and no more: text, number, select, toggle. A form the agent
// composes is a form nobody reviewed, so the vocabulary is small enough that
// every rendering is one a designer has seen. A date picker, a file upload or a
// rich-text field would each be a component with its own states and its own
// failure modes arriving through a projection.
//
// Every field has a real <label> bound by `htmlFor`; required fields are marked
// in text, never by colour alone.

import { useState } from "react";
import { z } from "zod";
import { Frame, baseProps } from "./kit";

export const FormFieldSchema = z.strictObject({
  name: z.string().min(1).max(60),
  label: z.string().min(1).max(160),
  kind: z.enum(["text", "number", "select", "toggle"]),
  placeholder: z.string().max(120).optional(),
  help: z.string().max(300).optional(),
  required: z.boolean().optional(),
  options: z
    .array(z.strictObject({ value: z.string().max(120), label: z.string().max(160) }))
    .max(40)
    .optional(),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

export const FormSchema = z.strictObject({
  ...baseProps,
  title: z.string().max(200).optional(),
  fields: z.array(FormFieldSchema).max(24),
  submitLabel: z.string().max(60).optional(),
  /** Set once submitted; the form freezes and shows what was sent. */
  submitted: z.boolean().optional(),
});
export type FormProps = z.infer<typeof FormSchema> & {
  onSubmit?: (values: Record<string, string | number | boolean>) => void;
};

export function Form(props: FormProps) {
  const [values, setValues] = useState<Record<string, string | number | boolean>>(() =>
    Object.fromEntries(
      props.fields.map((f) => [f.name, f.value ?? (f.kind === "toggle" ? false : "")]),
    ),
  );
  const set = (name: string, v: string | number | boolean) =>
    setValues((prev) => ({ ...prev, [name]: v }));

  return (
    <Frame
      kind={`p-form ${props.submitted ? "submitted" : ""}`}
      label={props.label}
      state={props.state}
      error={props.error}
      empty={props.fields.length === 0}
      emptyText="Nothing to fill in."
      skeleton={4}
    >
      {props.title ? <p className="p-form-title">{props.title}</p> : null}
      <form
        className="p-form-fields"
        onSubmit={(e) => {
          e.preventDefault();
          props.onSubmit?.(values);
        }}
      >
        {props.fields.map((f) => {
          const id = `f-${f.name}`;
          return (
            <div className="p-form-field" key={f.name}>
              <label className="p-form-label" htmlFor={id}>
                {f.label}
                {f.required ? <span className="p-form-required"> required</span> : null}
              </label>
              {f.kind === "select" ? (
                <select
                  id={id}
                  className="p-input"
                  disabled={props.submitted}
                  value={String(values[f.name] ?? "")}
                  onChange={(e) => set(f.name, e.target.value)}
                >
                  {(f.options ?? []).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : f.kind === "toggle" ? (
                <input
                  id={id}
                  className="p-toggle"
                  type="checkbox"
                  disabled={props.submitted}
                  checked={values[f.name] === true}
                  onChange={(e) => set(f.name, e.target.checked)}
                />
              ) : (
                <input
                  id={id}
                  className="p-input"
                  type={f.kind === "number" ? "number" : "text"}
                  disabled={props.submitted}
                  placeholder={f.placeholder}
                  value={String(values[f.name] ?? "")}
                  onChange={(e) =>
                    set(f.name, f.kind === "number" ? Number(e.target.value) : e.target.value)
                  }
                />
              )}
              {f.help ? <p className="p-form-help">{f.help}</p> : null}
            </div>
          );
        })}
        <div className="p-form-actions">
          <button type="submit" className="p-btn primary" disabled={props.submitted}>
            {props.submitted ? "Sent" : (props.submitLabel ?? "Submit")}
          </button>
        </div>
      </form>
    </Frame>
  );
}
