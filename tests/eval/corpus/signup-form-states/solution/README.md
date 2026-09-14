# Signup form

Static files. Serve the directory and open the root:

```sh
python3 -m http.server
```

Validation runs on blur and on submit: the email must look like an address, the
password must be at least ten characters, and the confirmation must match.
Errors are announced through `role="alert"` and bound to their input with
`aria-describedby`; the submit button stays disabled until every field is valid.
A successful submit replaces the form with a `role="status"` confirmation.
