// The project's existing field schema. Screens read it; they do not restate it.
export const FIELDS = [
  { name: "name", label: "Your name", type: "text", required: true },
  { name: "email", label: "Email", type: "email", required: true },
  { name: "message", label: "What do you need?", type: "textarea", required: true, min: 12 },
];
