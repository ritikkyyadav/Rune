# How parseCsv handles quoting

## A doubled quote inside a quoted field

Inside a quoted field a `"` is only special when it is not followed by another
`"`. Two quotes in a row are consumed together and one literal `"` is appended
to the field, so `"x""y"` parses as the single field `x"y`. A single `"` closes
the field instead.

## A CRLF inside a quoted field

While the parser is inside quotes, the record-terminator branches are never
reached: `\r` and `\n` are ordinary characters and are appended to the field
exactly as written. `"a\r\nb"` is therefore one field whose value still holds
the CRLF, and the record does not end there. Outside quotes the same bytes end
the record, and a `\r\n` pair ends it once, not twice.

## A leading BOM

A U+FEFF at the very start of the input is stripped before parsing begins, so
the first field of the first record does not carry it. A BOM anywhere else is
ordinary text and is kept.

## What is not handled

Whitespace is never trimmed: it is part of the field, inside quotes or out. An
unterminated quoted field raises an error at end of input rather than being
closed silently.
