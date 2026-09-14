# Fieldnotes Studio board

Static files only. Serve the directory and open the root:

```sh
bunx --bun serve . # or: python3 -m http.server
```

`index.html` reads `projects.json` at load, filters by status and search together,
and keeps favorites in `localStorage` under `fieldnotes:favorites`. Test it by
searching, switching the All/Active/Archived filters, toggling a favorite with
the keyboard and reloading, and by checking 1440px and 390px widths.
