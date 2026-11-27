/**
 * The extraction prompt, kept apart from the request that sends it: this file is the
 * strategy (what counts as a question, how big an answer may be), `extract.ts` is the
 * mechanics (call the model, parse the JSON, validate it). Only the former changes when the
 * model needs different instructions.
 */
import type { ExtensionConfig } from "./config.ts";
import { MAX_LABEL_LENGTH, MIN_OPTIONS } from "./vendor/tool/types.ts";

/** The config keys the prompt spells out. */
export type PromptLimits = Pick<ExtensionConfig, "maxOptions" | "maxQuestions">;

/**
 * The question/option caps are spelled out in the prompt because the model has to aim at
 * them: a post-hoc validator can only reject an oversized answer, while the prompt is what
 * keeps it small in the first place.
 */
export function systemPrompt({ maxOptions, maxQuestions }: PromptLimits): string {
	return `You convert the questions an assistant asked into a structured questionnaire.
You receive the tail of the assistant's latest reply, trimmed to the parts where it asks the user
a question. Extract every question it asks, and give each one a short header plus
${MIN_OPTIONS}-${maxOptions} answer options the user can pick from.

A numbered list (1. … 2. …) or a lettered one (a) … b) …) of things the user could do next is a
question too, even when the line above it has no question mark: the list items are the options,
the line introducing them is the question. Such a question is multi-select, because next steps can
be done together, unless the list is explicitly a set of alternatives to pick one from. A bullet
or dash list is not a question on its own — but when a question line introduces it, its items are
that question's options. A numbered list that reports facts is not a question either — problems
found, steps already taken, test results, plain observations offer nothing to choose. Only a list
of candidate actions or explicit alternatives counts; judge by what the introducing sentence says.

The reply may be written in any language. A Chinese question often ends in 吗 or 呢 instead of a
question mark, and its lists are marked 1、 or （1） as well as 1. — treat all of them the same way.

Reply with compact JSON only — no whitespace, no prose, no code fences:
{"questions":[{"question":"...","header":"...","multiSelect":false,"options":[{"label":"...","description":"..."}]}]}

Rules:
- At most ${maxQuestions} questions; pick the ${maxQuestions} most important if the reply asks more.
- "question" repeats the question verbatim in its own language (or as close as the fragments
  allow); when the reply only lists numbered or lettered next steps, write the question it implies
  ("Which step should I take next?").
- One option per numbered or lettered list item, with the item text as the "label". Such a list is
  one multi-select question ("multiSelect": true) so several items can be picked at once; set it to
  false only when the list is a set of mutually exclusive alternatives.
- A list of exactly one item cannot fill a question on its own: ask whether to do it, with
  "Yes" and "No" options, instead of repeating the item as both question and option.
- "header" is a tab label of at most 10 characters.
- "description" is one short sentence of at most 60 characters with no ending punctuation.
- Each option "label" is at most ${MAX_LABEL_LENGTH} characters and must be a concrete answer,
  not a restatement of the question.
- Never emit an option labelled "Other" or "Type something." — the dialog adds those itself.
- Emit exactly the keys shown above; never add "preview" or any other key.
- If the fragments ask the user nothing (no question and no numbered list of next steps),
  reply {"questions":[]}.`;
}
