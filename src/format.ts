/**
 * Compact, token-lean rendering of questionnaire answers for the main conversation.
 *
 * Three savings over the old `formatAnswers` in `index.ts`:
 * 1. Question text is never restated — the main model asked it moments ago, so each
 *    line is keyed by the extracted short `header` (its whole purpose); `Q{n}` is the
 *    fallback when the header is missing or duplicated.
 * 2. When the original reply numbered its own option list, answers are echoed as
 *    the user-visible numbers (`Cache → 2`) instead of full option labels.
 *    The mapping is derived by `numberedOptions` and degrades per-question: any
 *    doubt (question text not found, a label missing from the numbered list)
 *    falls back to echoing the complete label. A wrong number is far worse than
 *    a few extra tokens.
 * 3. Unanswered questions emit no line at all — the model sees its own questions
 *    and will re-ask what it does not see an answer for.
 */
import { formatAnswerScalar, NO_INPUT_PLACEHOLDER } from "./vendor/tool/format-answer.ts";
import type { QuestionAnswer, QuestionData, QuestionParams } from "./vendor/tool/types.ts";
import type { QuestionnaireResult } from "./vendor/tool/types.ts";

/** How many lines below the question line to scan for its numbered option list. */
const NUMBERED_WINDOW = 12;
/** Longest prefix of the normalized question text used as the anchor when matching reply lines. */
const QUESTION_ANCHOR_CHARS = 80;

/** Collapse all whitespace runs so reply wrapping cannot break the anchor match. */
function normalizeWhitespace(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

const NUMBERED_LINE = /^\s*(\d+)[.)]\s+(.+)$/;

/**
 * Map each question's option labels to the numbers used in the original reply, when the
 * reply numbered that option list itself.
 *
 * Returns one entry per question, aligned with `params.questions` order: the option
 * numbers (`numbers[qIndex][optionIndex]`), or `undefined` when that question must fall
 * back to full labels. Per-question, all-or-nothing: every option label must be found as
 * a prefix of a consecutive numbered line, otherwise the whole question degrades.
 */
export function numberedOptions(reply: string, params: QuestionParams): (number[] | undefined)[] {
	const lines = reply.split("\n");
	return params.questions.map((question) => {
		const anchor = normalizeWhitespace(question.question).slice(0, QUESTION_ANCHOR_CHARS);
		if (anchor.length === 0) return undefined;
		const start = lines.findIndex((line) => normalizeWhitespace(line).includes(anchor));
		if (start === -1) return undefined;

		// First numbered line within the window, then the consecutive run of numbered
		// lines (blank lines allowed inside the run).
		let firstNumbered = -1;
		const end = Math.min(lines.length, start + NUMBERED_WINDOW);
		for (let i = start; i < end; i += 1) {
			if (NUMBERED_LINE.test(lines[i]!)) {
				firstNumbered = i;
				break;
			}
		}
		if (firstNumbered === -1) return undefined;

		const items: { number: number; text: string }[] = [];
		for (let i = firstNumbered; i < end; i += 1) {
			const line = lines[i]!;
			if (line.trim().length === 0) continue;
			const match = NUMBERED_LINE.exec(line);
			if (!match) break;
			items.push({ number: Number(match[1]), text: normalizeWhitespace(match[2]!) });
		}

		const numbers: number[] = [];
		for (const option of question.options) {
			const label = normalizeWhitespace(option.label);
			// Prefix match tolerates "1. Label — some explanation" in the reply.
			const hit = items.find((item) => item.text.startsWith(label) && label.length > 0);
			if (!hit) return undefined;
			numbers.push(hit.number);
		}
		return numbers;
	});
}

/**
 * Line key per question: the extracted header when it is non-empty and unique across
 * all questions (its whole purpose is to be a short label the model maps back),
 * otherwise `Q{n}` keyed off `questionIndex` — never the answers array position, since
 * the vendored `orderedAnswers()` compacts unanswered questions out and array indexing
 * would mislabel every answer after the first skipped one.
 */
function answerKeys(params: QuestionParams): string[] {
	const headers = params.questions.map((q) => q.header?.trim() ?? "");
	const counts = new Map<string, number>();
	for (const header of headers) counts.set(header, (counts.get(header) ?? 0) + 1);
	return params.questions.map((question, i) => {
		const header = question.header?.trim() ?? "";
		return header && counts.get(header) === 1 ? header : `Q${i + 1}`;
	});
}

function noteSuffix(answer: QuestionAnswer): string {
	const notes = answer.notes?.trim();
	return notes ? ` | note: ${notes}` : "";
}

/** Resolve one selected multi-select label to its reply number when numbering is available. */
function multiPart(
	label: string,
	question: QuestionData,
	numbers: number[] | undefined,
): string {
	const index = question.options.findIndex((option) => option.label === label);
	const number = index >= 0 ? numbers?.[index] : undefined;
	return number !== undefined ? String(number) : label;
}

interface AnswerSegment {
	/** `"→"` when the value echoes the reply's own option numbers, `":"` for free text. */
	marker: "→" | ":";
	value: string;
}

/**
 * Resolve one answered question's value: the reply's numbers (`→ n[, m…]`) when its own
 * numbering covers the choice, otherwise the full answer text (`: text`). A non-empty
 * multi custom text trails the selected labels (`→ 1, 3 | my text`).
 */
function answerSegment(
	answer: QuestionAnswer,
	question: QuestionData,
	numbers: number[] | undefined,
): AnswerSegment {
	if (answer.kind === "custom") {
		return { marker: ":", value: formatAnswerScalar(answer, "summary") };
	}

	if (answer.kind === "multi") {
		const selected = answer.selected ?? [];
		const hasText = (answer.answer ?? "").length > 0;
		if (selected.length === 0 && !hasText) {
			return { marker: ":", value: NO_INPUT_PLACEHOLDER };
		}
		// `→` only when a numbered selection exists; custom text alone is free text.
		const marker = numbers !== undefined && selected.length > 0 ? "→" : ":";
		const labels = selected.map((label) => multiPart(label, question, numbers)).join(", ");
		// Custom text trails the selection (`→ 1, 3 | my text`), before any note suffix.
		const value = hasText && selected.length > 0 ? `${labels} | ${answer.answer}` : hasText ? answer.answer! : labels;
		return { marker, value };
	}

	// kind === "option": `answer` is the chosen label.
	const index = question.options.findIndex((option) => option.label === answer.answer);
	const number = index >= 0 ? numbers?.[index] : undefined;
	return number !== undefined
		? { marker: "→", value: String(number) }
		: { marker: ":", value: formatAnswerScalar(answer, "summary") };
}

/**
 * Compact answers envelope for the main conversation. One line per answered question:
 *
 * ```
 * Cache → 2
 * Features → 1, 3 | note: prefer disk
 * Name: my own words
 * note: global remark
 * ```
 *
 * Lines are keyed by the extracted header (fallback `Q{n}`); unanswered questions —
 * absent from `result.answers` or carrying only the empty-input placeholder — emit no
 * line, so the model re-asks exactly what it sees no answer for.
 */
export function formatAnswersCompact(
	result: QuestionnaireResult,
	params: QuestionParams,
	reply: string,
): string {
	const numbers = numberedOptions(reply, params);
	const keys = answerKeys(params);
	const byIndex = new Map<number, QuestionAnswer>();
	for (const answer of result.answers) byIndex.set(answer.questionIndex, answer);

	const lines: string[] = [];
	for (let i = 0; i < params.questions.length; i += 1) {
		const answer = byIndex.get(i);
		if (!answer) continue; // unanswered: no line at all
		const segment = answerSegment(answer, params.questions[i]!, numbers[i]);
		if (segment.value === NO_INPUT_PLACEHOLDER) continue;
		// `→` reads best with air on both sides (`Cache → 2`); `:` always gets a
		// trailing space (`Name: text`).
		const separator = segment.marker === "→" ? " → " : ": ";
		lines.push(`${keys[i]}${separator}${segment.value}${noteSuffix(answer)}`);
	}

	const globalNote = result.globalNote?.trim();
	if (globalNote) lines.push(`note: ${globalNote}`);
	return lines.join("\n");
}
