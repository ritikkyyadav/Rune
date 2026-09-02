// ─── The product mark ───
//
// D2 is unanswered: the founder has not supplied a Gear mark, and has not ruled
// on whether the product is "Gear" or "Savoir Gear". Until then the mark is the
// word, set in the Savoir lockup construction — bold, tight-tracked sans,
// terminated by the block cursor.
//
// That cursor is the whole identity and the reason this is a defensible
// placeholder rather than a holding pattern: it reads at once as a terminal
// caret, a placed datum, and a declarative full stop. Dimensions are in `em`,
// so the lockup scales with its type and the proportion cannot drift.
//
// The nine-tooth gear glyph survives only as the WORKING indicator (it rotates
// while a turn runs). It is not the brand: a spinning cog is a state, and the
// brand does not spin.

export function Wordmark({
  size = 15,
  className = "",
  live = false,
}: {
  size?: number;
  /** Blink the cursor. Reserved for genuinely live placements. */
  live?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`wordmark ${live ? "live" : ""} ${className}`.trim()}
      style={{ fontSize: size }}
      aria-label="Gear"
    >
      Gear
      <i className="wm-cursor" aria-hidden="true" />
    </span>
  );
}
