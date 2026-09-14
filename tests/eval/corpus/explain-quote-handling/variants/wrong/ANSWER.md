# How parseCsv handles quoting

A doubled quote inside a quoted field is treated as the end of the field, so
`"x""y"` yields `x` and `y` as two fields. A CRLF inside a quoted field ends the
record like any other newline. A leading BOM is kept as part of the first field.
