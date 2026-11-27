import { displayLabel } from "./state/i18n-bridge.ts";
import { sentinelsToAppend } from "./state/row-intent.ts";
import type { QuestionData } from "./tool/types.ts";
import type { WrappingSelectItem } from "./view/components/wrapping-select.ts";

/**
 * Synthesize the per-question row list the dialog expects: real options first, then the
 * reserved sentinel rows ("Type something." / "Next"). Upstream keeps this inside
 * `ask-user-question.ts` next to the tool registration; this fork has no tool, so it
 * lives with the vendored dialog instead.
 */
export function buildItemsForQuestion(question: QuestionData): WrappingSelectItem[] {
	const items: WrappingSelectItem[] = question.options.map((o) => ({
		kind: "option",
		label: o.label,
		description: o.description,
	}));
	for (const kind of sentinelsToAppend(question)) {
		items.push({ kind, label: displayLabel(kind) });
	}
	return items;
}
