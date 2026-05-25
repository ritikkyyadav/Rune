// ─── Alan Status Spinner ───
// Animated terminal spinner with rotating activity words

// ─── Spinner Frames ───
// Geometric rotation frames matching the terminal design
const FRAMES = ["\u25DC", "\u25DD", "\u25DE", "\u25DF"];

// ─── Colors (L'Atlas Terminal Palette) ───
import { bold, dim, vermillion, brass, cyanotype, green, draftLine, stripAnsi } from "./colors";

// ─── Status Word Categories ───

type ActivityType =
  | "thinking"
  | "reading"
  | "writing"
  | "executing"
  | "searching"
  | "planning"
  | "tool_call";

const STATUS_WORDS: Record<ActivityType, string[]> = {
  thinking: [
    "Pondering",
    "Contemplating",
    "Reasoning",
    "Synthesizing",
    "Deliberating",
    "Musing",
    "Theorizing",
    "Hypothesizing",
    "Unraveling",
    "Crystallizing",
    "Distilling",
    "Computing",
    "Inferring",
    "Deducing",
    "Weaving",
    "Forging",
    "Composing",
    "Architecting",
    "Devising",
    "Conceiving",
    "Envisioning",
    "Conjuring",
    "Manifesting",
    "Ruminating",
    "Meditating",
    "Brewing",
    "Simmering",
    "Percolating",
    "Coalescing",
    "Converging",
    "Fathoming",
    "Decoding",
    "Abstracting",
    "Interpolating",
    "Extrapolating",
  ],
  reading: [
    "Scanning",
    "Inspecting",
    "Examining",
    "Probing",
    "Surveying",
    "Scouting",
    "Mapping",
    "Indexing",
    "Tracing",
    "Spelunking",
    "Excavating",
    "Unearthing",
    "Deciphering",
    "Dissecting",
    "Absorbing",
    "Digesting",
    "Consuming",
    "Ingesting",
    "Traversing",
    "Navigating",
  ],
  writing: [
    "Sculpting",
    "Etching",
    "Inscribing",
    "Crafting",
    "Chiseling",
    "Molding",
    "Shaping",
    "Refining",
    "Polishing",
    "Tempering",
    "Calibrating",
    "Stitching",
    "Splicing",
    "Patching",
    "Engraving",
    "Imprinting",
    "Embossing",
    "Welding",
    "Soldering",
    "Assembling",
  ],
  executing: [
    "Deploying",
    "Launching",
    "Igniting",
    "Triggering",
    "Dispatching",
    "Orchestrating",
    "Invoking",
    "Summoning",
    "Channeling",
    "Unleashing",
    "Propelling",
    "Transmitting",
    "Relaying",
    "Activating",
    "Bootstrapping",
    "Materializing",
    "Instantiating",
  ],
  searching: [
    "Hunting",
    "Sifting",
    "Rummaging",
    "Combing",
    "Ferreting",
    "Sleuthing",
    "Tracking",
    "Prowling",
    "Foraging",
    "Trawling",
    "Dredging",
    "Panning",
    "Prospecting",
    "Divining",
    "Dowsing",
    "Scrying",
  ],
  planning: [
    "Strategizing",
    "Blueprinting",
    "Scheming",
    "Charting",
    "Plotting",
    "Drafting",
    "Sketching",
    "Outlining",
    "Roadmapping",
    "Waypointing",
    "Pathfinding",
    "Triangulating",
  ],
  tool_call: [
    "Wiring",
    "Routing",
    "Bridging",
    "Piping",
    "Interfacing",
    "Handshaking",
    "Signaling",
    "Pulsing",
    "Syncing",
    "Linking",
  ],
};

// Map tool names to activity types
function toolToActivity(toolName: string): ActivityType {
  switch (toolName) {
    case "read_file":
    case "list_dir":
      return "reading";
    case "grep":
      return "searching";
    case "write_file":
    case "edit_file":
      return "writing";
    case "bash":
      return "executing";
    default:
      return "tool_call";
  }
}

// Pick a random word from a category (avoid immediate repeats)
let lastWord = "";
function pickWord(activity: ActivityType): string {
  const words = STATUS_WORDS[activity];
  let word: string;
  do {
    word = words[Math.floor(Math.random() * words.length)];
  } while (word === lastWord && words.length > 1);
  lastWord = word;
  return word;
}

// Color the spinner symbol based on activity
function colorSymbol(frame: string, activity: ActivityType): string {
  switch (activity) {
    case "thinking":
      return vermillion(frame);
    case "reading":
      return cyanotype(frame);
    case "writing":
      return brass(frame);
    case "executing":
      return vermillion(frame);
    case "searching":
      return cyanotype(frame);
    case "planning":
      return cyanotype(frame);
    case "tool_call":
      return draftLine(frame);
  }
}

// Format elapsed time
function formatTime(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m${remSecs}s`;
}

// ─── Spinner Class ───

export class Spinner {
  private frameIndex = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private startTime = 0;
  private activity: ActivityType = "thinking";
  private currentWord = "";
  private tokens = 0;
  private lastLineLen = 0;
  private wordChangeInterval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  start(activity: ActivityType = "thinking"): void {
    if (this.running) this.stop();
    this.running = true;
    this.activity = activity;
    this.startTime = Date.now();
    this.frameIndex = 0;
    this.tokens = 0;
    this.currentWord = pickWord(activity);

    // Rotate words every 3-5 seconds
    this.wordChangeInterval = setInterval(
      () => {
        this.currentWord = pickWord(this.activity);
      },
      3000 + Math.random() * 2000,
    );

    // Animate at 120ms per frame (matches design reference)
    this.interval = setInterval(() => {
      this.render();
      this.frameIndex = (this.frameIndex + 1) % FRAMES.length;
    }, 120);
  }

  /** Update activity type (e.g., when a tool call starts) */
  setActivity(activity: ActivityType): void {
    this.activity = activity;
    this.currentWord = pickWord(activity);
  }

  /** Update activity based on tool name */
  setTool(toolName: string): void {
    this.setActivity(toolToActivity(toolName));
  }

  /** Add tokens to the counter */
  addTokens(count: number): void {
    this.tokens += count;
  }

  /** Whether the spinner is currently animating */
  isRunning(): boolean {
    return this.running;
  }

  /** Stop the spinner and clear the line */
  stop(): void {
    this.running = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.wordChangeInterval) {
      clearInterval(this.wordChangeInterval);
      this.wordChangeInterval = null;
    }
    this.clearLine();
  }

  private render(): void {
    const elapsed = formatTime(Date.now() - this.startTime);
    const frame = FRAMES[this.frameIndex];
    const symbol = colorSymbol(frame, this.activity);
    const word = bold(this.currentWord);
    const meta = dim(`${elapsed}${this.tokens > 0 ? ` \u00b7 ${this.tokens} tokens` : ""}`);
    const line = `  ${symbol} ${word}\u2026  ${meta}`;

    this.clearLine();
    process.stderr.write(line);
    this.lastLineLen = stripAnsi(line).length;
  }

  private clearLine(): void {
    if (this.lastLineLen > 0) {
      process.stderr.write(`\r${" ".repeat(this.lastLineLen)}\r`);
      this.lastLineLen = 0;
    }
  }
}

export { toolToActivity, type ActivityType };
