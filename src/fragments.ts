/**
 * Reply pre-processing for the extractor: what part of an assistant reply the extraction
 * model gets to see.
 *
 * Pure string handling with no imports on purpose — `node --test` loads this module
 * directly, without pi's runtime aliases for `typebox` and friends.
 */

/** A bullet item: on its own a summary line, under a question the options to pick from. */
const BULLET_LINE = /^\s*(?:[-*+•·])\s+/;
/**
 * A numbered item, in every shape a reply actually uses: `1.` `1)` `1、` `1．` `(1)` `（1）` `①`.
 *
 * The ASCII markers need a space after them — `2. 5 dollars` is prose, not a list — while the
 * CJK ones do not, because `1、重命名` is how they are written.
 */
const NUMBERED_LINE = /^(?:\s*\d+[.)]\s+|\s*\d+[、．]\s*|\s*[（(]\d+[）)]\s*|\s*[①-⑳]\s*)/;
/** A lettered item (`a)` `b.`): next-step lists use this shape as often as numbers. */
const LETTERED_LINE = /^\s*[A-Za-z][.)]\s+/;
/** Cap on lines per question block (the question line plus its list). */
const MAX_BLOCK_LINES = 12;

/** A list item of any marker — what a question block swallows as its options. */
function isListLine(line: string): boolean {
	return BULLET_LINE.test(line) || NUMBERED_LINE.test(line) || LETTERED_LINE.test(line);
}

/** Question marks, ASCII and full-width. */
const QUESTION_MARK = /[?？]/;
/**
 * Words that name a choice, so that a colon line introducing a list is a question:
 * `哪个` `是否` `要不要` `还是` `如何` `which` `should`. Kept to unambiguous cues — a false positive here
 * pulls prose into the fragments, a false negative drops the options below the line. Bare English
 * `what` / `how` are deliberately absent: `Here is what I would do:` introduces prose, not a choice.
 */
const CHOICE_CUE =
	/哪|什么|是否|要不要|还是|如何|怎么|怎样|\bwhich\b|\bshould\b|\bshall\b|\bwould you\b|\bdo you\b|\bwant me to\b|\bpick\b|\bchoose\b|\bprefer\b/i;

/**
 * Chinese yes/no questions that open with a choice instead of closing with `吗`:
 * `要不要…` `是否…` `能否…` `请问…`. Anchored at the start of the line, because the same words
 * inside a sentence are usually a statement about a condition.
 */
const YES_NO_OPENING = /^(?:要不要|需不需要|是否需要|是不是|能不能|可不可以|可否|请问|是否|要吗|需要吗)/;

/**
 * Does `line` ask the user something?
 *
 * A question mark is the plain answer. A Chinese question can do without one: a line ending
 * in `吗`/`呢` asks one, and so does a line that opens with `要不要`/`是否` — unless it closes with
 * a full stop, which makes it a statement. A line ending in a colon asks one when it names a
 * choice (`用哪个缓存：`, `Which cache:`) — the options follow it. Prose that merely ends in a
 * colon does not: `Here is the plan:` names no choice, and the list under it is not a set of
 * alternatives.
 */
function isQuestionLine(line: string): boolean {
	const trimmed = line.trim();
	if (QUESTION_MARK.test(trimmed)) return true;
	if (/[吗呢]$/.test(trimmed)) return true;
	if (!/[。.]$/.test(trimmed) && YES_NO_OPENING.test(trimmed)) return true;
	if (!/[:：]$/.test(trimmed)) return false;
	return CHOICE_CUE.test(trimmed.slice(0, -1));
}

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
 * A block opens at a question line, and at a numbered or lettered list: that second shape is
 * the "next steps" case — the list of things the user could do next *is* the question, so
 * the sentence introducing it is kept as the question text. Each block swallows the list
 * lines following it (the candidate options), bullets included; everything between blocks
 * is dropped, since the extractor only needs the questions and their options, not the
 * surrounding prose.
 *
 * A question does not need a literal "?" — see `isQuestionLine`, which also takes a Chinese
 * `吗`/`呢` ending and a colon line that names a choice. That is what makes a bullet list of
 * options reachable: bullets never open a block themselves, they are only ever swallowed by
 * the question above them. A bullet list with no question over it is a summary, not a set of
 * choices, and stays out of every block. A line that merely ends in a colon does not open
 * anything either: it introduces the list below it, and that list opens the block anyway.
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
		if (isQuestionLine(line)) {
			closeBlock();
			current = [line];
			continue;
		}
		if (NUMBERED_LINE.test(line) || LETTERED_LINE.test(line)) {
			// A numbered or lettered run asks something by itself; lead it with the sentence above it.
			if (!current) {
				const intro = lineAbove(lines, index);
				current = intro !== undefined && !isListLine(lines[intro]!) ? [lines[intro]!] : [];
			}
			appendToBlock(line);
			continue;
		}
		if (!current) continue;
		if (trimmed.length === 0 || isListLine(line)) appendToBlock(line);
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
