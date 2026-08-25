type Rgb = [number, number, number];

export interface TerminalColors {
  foreground?: Rgb;
  background?: Rgb;
}

function parseHexColor(value: string | undefined): Rgb | undefined {
  const match = value?.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!match) return undefined;
  const n = Number.parseInt(match[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function ansi256ToRgb(index: number): Rgb | undefined {
  if (!Number.isInteger(index) || index < 0 || index > 255) return undefined;
  const basic: Rgb[] = [
    [0, 0, 0],
    [128, 0, 0],
    [0, 128, 0],
    [128, 128, 0],
    [0, 0, 128],
    [128, 0, 128],
    [0, 128, 128],
    [192, 192, 192],
    [128, 128, 128],
    [255, 0, 0],
    [0, 255, 0],
    [255, 255, 0],
    [0, 0, 255],
    [255, 0, 255],
    [0, 255, 255],
    [255, 255, 255],
  ];
  if (index < 16) return basic[index];
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return [level, level, level];
  }
  const n = index - 16;
  const levels = [0, 95, 135, 175, 215, 255];
  return [levels[Math.floor(n / 36)]!, levels[Math.floor((n % 36) / 6)]!, levels[n % 6]!];
}

function environmentColors(env: NodeJS.ProcessEnv): TerminalColors {
  const explicitForeground = parseHexColor(env.GEAR_TERMINAL_FOREGROUND);
  const explicitBackground = parseHexColor(env.GEAR_TERMINAL_BACKGROUND);
  if (explicitForeground || explicitBackground) {
    return { foreground: explicitForeground, background: explicitBackground };
  }

  const indexes = env.COLORFGBG?.split(/[;:]/)
    .map((part) => Number.parseInt(part, 10))
    .filter(Number.isFinite);
  if (!indexes?.length) return {};
  return {
    foreground: ansi256ToRgb(indexes[0]!),
    background: ansi256ToRgb(indexes.at(-1)!),
  };
}

function parseOscRgb(value: string): Rgb | undefined {
  if (value.startsWith("#")) return parseHexColor(value);
  const parts = value.slice(4).split("/");
  if (parts.length !== 3 || parts.some((part) => !/^[0-9a-f]+$/i.test(part))) return undefined;
  return parts.map((part) => {
    const max = 16 ** part.length - 1;
    return Math.round((Number.parseInt(part, 16) / max) * 255);
  }) as Rgb;
}

const OSC_COLOR_RESPONSE_SOURCE = String.raw`\x1b\](10|11);(rgb:[0-9a-f]+\/[0-9a-f]+\/[0-9a-f]+|#[0-9a-f]{6})(?:\x07|\x1b\\)`;

/** Remove only terminal color-query replies, preserving any keys typed during startup. */
export function stripTerminalColorResponses(input: string): string {
  return input.replace(new RegExp(OSC_COLOR_RESPONSE_SOURCE, "gi"), "");
}

/** Parse OSC 10/11 responses emitted by xterm-compatible terminals. */
export function parseTerminalColorResponses(input: string): TerminalColors {
  const colors: TerminalColors = {};
  const response = new RegExp(OSC_COLOR_RESPONSE_SOURCE, "gi");
  for (const match of input.matchAll(response)) {
    const color = parseOscRgb(match[2]!);
    if (!color) continue;
    if (match[1] === "10") colors.foreground = color;
    if (match[1] === "11") colors.background = color;
  }
  return colors;
}

/** Ask the host terminal for its live colors, with COLORFGBG / explicit env
 * values as a zero-risk fallback. The short timeout keeps startup imperceptible
 * on terminals that do not answer OSC queries. */
export async function detectTerminalColors(timeoutMs = 120): Promise<TerminalColors> {
  const fallback = environmentColors(process.env);
  const input = process.stdin;
  if (!input.isTTY || !process.stdout.isTTY) return fallback;

  return new Promise<TerminalColors>((resolve) => {
    let buffer = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const wasPaused = input.isPaused();
    const wasRaw = Boolean(input.isRaw);

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.off("data", onData);
      if (!wasRaw) input.setRawMode(false);
      if (wasPaused) input.pause();
      const typedDuringProbe = stripTerminalColorResponses(buffer);
      if (typedDuringProbe) {
        try {
          input.unshift(typedDuringProbe);
        } catch {
          // The input stream may already be ending; color detection still succeeds safely.
        }
      }
      const queried = parseTerminalColorResponses(buffer);
      resolve({
        foreground: queried.foreground ?? fallback.foreground,
        background: queried.background ?? fallback.background,
      });
    };

    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const parsed = parseTerminalColorResponses(buffer);
      if (parsed.foreground && parsed.background) finish();
    };

    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
    timer = setTimeout(finish, timeoutMs);
    process.stdout.write("\x1b]10;?\x07\x1b]11;?\x07");
  });
}
