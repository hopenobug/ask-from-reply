/**
 * Reply pre-processing for the extractor: what part of an assistant reply the extraction
 * model gets to see.
 *
 * Pure string handling with no imports on purpose — `node --test` loads this module
 * directly, without pi's runtime aliases for `typebox` and friends.
 */

/** A bullet / numbered / lettered list item that can belong to a question block. */
const LIST_LINE = /^\s*(?:[-*+]|\d+[.)]|[A-Za-z][.)])\s+/;
/** A numbered list item — the only list shape that counts as a question on its own. */
const NUMBERED_LINE = /^\s*\d+[.)]\s+/;
/** Cap on lines per question block (the question line plus its list). */
const MAX_BLOCK_LINES = 12;

/** Index of the closest non-blank line above `index`, skipping over blank lines. */
function lineAbove(lines: string[], index: number): number | undefined {
	for (let i = index - 1; i >= 0; i -= 1) {
		if (lines[i]!.trim().length > 0) return i;
	}
	return undefined;
}

/**
 * Keep only the parts of `reply` where it asks the user something.
 *
 * A block opens at a line containing a question mark, and at a numbered list: that second
 * shape is the "后续可以执行" case — the list of things the user could do next *is* the
 * question, so the sentence introducing it is kept as the question text. Each block
 * swallows the list lines following it (the candidate options); everything between blocks
 * is dropped, since the extractor only needs the questions and their options, not the
 * surrounding prose.
 *
 * Bullet and dash lists never open a block on their own: a plain bullet list is a summary,
 * not a set of choices. Neither does a line that merely ends in a colon — it introduces the
 * list below it, and that list opens the block anyway.
 *
 * A reply with no opener at all is returned unchanged, so a question phrased without a
 * literal "?" still reaches the extractor. A block that outgrows `MAX_BLOCK_LINES` splits
 * at the cap — an over-long list reaches the extractor as two blocks, with every line kept.
 */
export function focusQuestionFragments(reply: string): string {
	const lines = reply.split("\n");
	const blocks: string[] = [];
	let current: string[] | undefined;
	const closeBlock = () => {
		if (!current) return;
		while (current.length > 0 && current[current.length - 1]!.trim().length === 0) current.pop();
		if (current.length > 0) blocks.push(current.join("\n"));
		current = undefined;
	};
	/**
	 * Append to the open block. Once it holds `MAX_BLOCK_LINES` lines the block closes and
	 * the overflow line opens the next one: a very long list is split, never truncated —
	 * dropping the 13th line would silently delete a candidate option.
	 */
	const appendToBlock = (line: string) => {
		if (!current) return;
		if (current.length < MAX_BLOCK_LINES) current.push(line);
		else {
			closeBlock();
			current = [line];
		}
	};
	for (const [index, line] of lines.entries()) {
		const trimmed = line.trim();
		if (trimmed.includes("?") || trimmed.includes("？")) {
			closeBlock();
			current = [line];
			continue;
		}
		if (NUMBERED_LINE.test(line)) {
			// A numbered run asks something by itself; lead it with the sentence above it.
			if (!current) {
				const intro = lineAbove(lines, index);
				current = intro !== undefined && !LIST_LINE.test(lines[intro]!) ? [lines[intro]!] : [];
			}
			appendToBlock(line);
			continue;
		}
		if (!current) continue;
		if (trimmed.length === 0 || LIST_LINE.test(line)) appendToBlock(line);
		else closeBlock();
	}
	closeBlock();
	return blocks.length === 0 ? reply : blocks.join("\n");
}

/**
 * The tail of `reply`, at most `limit` characters. Counted in code points rather than
 * UTF-16 units so an emoji or a CJK character costs one, and cut from the end because a
 * long reply usually builds up to the questions at its end.
 */
export function replyTail(reply: string, limit: number): string {
	const chars = Array.from(reply);
	return chars.length <= limit ? reply : chars.slice(chars.length - limit).join("");
}
