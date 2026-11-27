/**
 * Rows for the Submit tab's sent-text preview.
 *
 * Kept as a plain string function (no pi-tui types, no class) so the preview contract —
 * *the lines shown are exactly the lines that get sent* — is testable without a terminal;
 * `SubmitTabStrategy` only wraps each row in a styled `Text`.
 */
export function sentTextLines(text: string): string[] {
	const trimmed = text.replace(/\s+$/, "");
	return trimmed.length === 0 ? [] : trimmed.split("\n");
}
