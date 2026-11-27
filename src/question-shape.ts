/**
 * Shape guard for the JSON the extractor model hands back.
 *
 * `normalizeQuestionParams` / `validateQuestionnaire` both assume the structure is already
 * correct (`q.options.map(...)`, `typed.questions.length`), so a model that omits `options`
 * used to crash with `Cannot read properties of undefined (reading 'map')` and the caller
 * surfaced that TypeError as the user-facing reason. This module runs first and turns every
 * structural defect into a sentence a user can act on.
 *
 * Strictness mirrors `vendor/tool/types.ts` (the typebox schema): a field the schema types as
 * a string has to be a string, and the fields the schema marks optional may be absent but not
 * mistyped. Two deliberate differences, both because the alternative is a dialog the user
 * cannot use: `question`, `header`, and `label` must be non-empty (a blank tab, a blank chip,
 * or a blank row), while an empty `description` is fine (it just renders the label alone).
 *
 * Counts (`maxQuestions` / `maxOptions`) are NOT checked here — `validateQuestionnaire` owns
 * them, so a too-large questionnaire still gets the "At most N questions" wording.
 *
 * Pure: no pi import, no typebox runtime import, so `node --test` can load it directly.
 */
import type { QuestionParams } from "./vendor/tool/types.ts";

export type ShapeCheck =
	| { ok: true; params: QuestionParams }
	| { ok: false; reason: string };

const NOT_AN_OBJECT = "the model returned JSON that is not an object";
const NO_QUESTIONS_LIST = 'the model returned no "questions" list';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The string itself when it carries visible text, else undefined. */
function nonEmpty(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Check `value` (a parsed JSON document) against the questionnaire schema and return a
 * copy carrying only the keys the dialog understands. Reports the first defect by position,
 * 1-based, in the order a reader would hit it: question text, header, options, multiSelect.
 */
export function checkQuestionShape(value: unknown): ShapeCheck {
	if (!isRecord(value)) return { ok: false, reason: NOT_AN_OBJECT };
	const rawQuestions = value.questions;
	if (!Array.isArray(rawQuestions)) return { ok: false, reason: NO_QUESTIONS_LIST };

	const questions: QuestionParams["questions"] = [];
	for (let i = 0; i < rawQuestions.length; i += 1) {
		const where = `question ${i + 1}`;
		const raw = rawQuestions[i];
		if (!isRecord(raw)) return { ok: false, reason: `${where} is not an object` };

		const question = nonEmpty(raw.question);
		if (question === undefined) return { ok: false, reason: `${where} has no text` };
		const header = nonEmpty(raw.header);
		if (header === undefined) return { ok: false, reason: `${where} has no header` };

		if (!Array.isArray(raw.options)) return { ok: false, reason: `${where} has no "options" list` };
		const options: QuestionParams["questions"][number]["options"] = [];
		for (let j = 0; j < raw.options.length; j += 1) {
			const at = `option ${j + 1} of ${where}`;
			const rawOption: unknown = raw.options[j];
			if (!isRecord(rawOption)) return { ok: false, reason: `${at} is not an object` };
			const label = nonEmpty(rawOption.label);
			if (label === undefined) return { ok: false, reason: `${at} has no label` };
			if (typeof rawOption.description !== "string") {
				return { ok: false, reason: `${at} has no description` };
			}
			if ("preview" in rawOption && typeof rawOption.preview !== "string") {
				return { ok: false, reason: `${at} has a "preview" that is not text` };
			}
			options.push({
				label,
				description: rawOption.description,
				// Only carry `preview` when the model actually sent one: `"preview" in option`
				// drives the preview pane, so an always-present key would change rendering.
				...("preview" in rawOption ? { preview: rawOption.preview as string } : {}),
			});
		}

		if ("multiSelect" in raw && typeof raw.multiSelect !== "boolean") {
			return { ok: false, reason: `${where} has a "multiSelect" that is not true or false` };
		}
		questions.push({
			question,
			header,
			options,
			...(typeof raw.multiSelect === "boolean" ? { multiSelect: raw.multiSelect } : {}),
		});
	}

	return { ok: true, params: { questions } };
}
