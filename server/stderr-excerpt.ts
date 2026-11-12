/** What to show a person when a child process dies without a result.
 *
 * Keeping the tail alone loses the sentence that says what went wrong: a
 * CLI states its error first and then prints context, and for the agent
 * CLIs that context is often a list of every tool it knows, hundreds of
 * names long.  A failure then reads as an inventory with the cause cut
 * off the front.
 *
 * So keep both ends: the head, which is the error, and the tail, which is
 * usually the last thing it tried.  The middle is what gets dropped, and
 * the reader is told how much.
 */
export const STDERR_EXCERPT_HEAD = 400;
export const STDERR_EXCERPT_TAIL = 200;

export function stderrExcerpt(
  stderr: string,
  head = STDERR_EXCERPT_HEAD,
  tail = STDERR_EXCERPT_TAIL,
): string {
  const text = stderr.trim();
  if (text.length <= head + tail) return text;
  const dropped = text.length - head - tail;
  return `${text.slice(0, head)}\n… ${dropped} characters omitted …\n${text.slice(-tail)}`;
}
