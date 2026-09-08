// --- fake-tty: force the colour path in a non-tty render ---
//
// `theme.ts` decides once, at module load, whether the terminal can be told
// colour at all (`Boolean(process.stdout.isTTY)`). A script that renders the
// UI into a file therefore gets the ANSI-16 floor and, more importantly, the
// no-bands path: the speaker band and the diff evidence bands degrade to
// foreground-only, which is not the layout the founder actually looks at.
//
// A pty is the honest way to get a tty and the wrong way to get a
// reproducible file: it reflows on the host terminal's width and it interleaves
// the child's own chrome. So the repo forces the flag instead, before any UI
// module is evaluated:
//
//     bun --preload ./scripts/fake-tty.ts scripts/render-live.ts …
//
// or, from a script that must work without the flag, as its FIRST import
// (`import "./fake-tty";`) — ES modules evaluate in import order, so the
// side effect lands before `theme.ts` reads the flag.

function force(stream: NodeJS.WriteStream, columns: number): void {
  try {
    Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
    if (stream.columns == null) {
      Object.defineProperty(stream, "columns", { value: columns, configurable: true });
    }
  } catch {
    // A stream that refuses the redefinition just keeps the plain path.
  }
}

force(process.stdout, 120);
force(process.stderr, 120);

// Truecolor, so the render is the palette the themes actually author rather
// than the host's sixteen-colour interpretation of it.
if (!process.env.COLORTERM) process.env.COLORTERM = "truecolor";
if (!process.env.TERM || process.env.TERM === "dumb") process.env.TERM = "xterm-256color";
delete process.env.NO_COLOR;
