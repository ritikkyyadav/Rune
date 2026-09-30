/** Text layout for the fixed-width reports. */

/** `text`, padded with spaces on the right to `width`. */
export function padRight(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/** `text`, padded with spaces on the left to `width`. */
export function padLeft(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}
