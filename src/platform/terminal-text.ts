/**
 * Terminal-safe text. Every string the CLI prints may echo something from an untrusted file (a bundle's
 * schema_version, a snapshot revision, an error message quoting input), and a terminal treats ESC, OSC, CSI,
 * bidirectional controls and carriage returns as commands, not text. Newline and tab are kept (the CLI prints
 * multi-line usage); everything else that is a control, format, separator or unassigned-private character is
 * replaced by a visible `\u{hex}` escape so the reader still sees that something was there.
 */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}\p{Cn}]/gu;

export function neutralize(text: string): string {
  return text.replace(UNSAFE, (ch) => {
    if (ch === "\n" || ch === "\t") return ch;
    return `\\u{${(ch.codePointAt(0) as number).toString(16)}}`;
  });
}
