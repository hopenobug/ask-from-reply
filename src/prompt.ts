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
Input is the tail of its last reply, trimmed to the parts that ask the user something. Give every
question a short header and ${MIN_OPTIONS}-${maxOptions} answer options.

A numbered list (1. … 2. …) or a lettered one (a) … b) …) of next steps is a question even without
a "?": the list items are the options and the line introducing them is the question, so it is
multi-select ("multiSelect": true) unless the list is a set of alternatives to pick one from. A
bullet or dash list is not a question on its own, but under a question line its items are that
question's options. A numbered list that reports facts is not a question: problems found or
results reported offer nothing to choose. Judge by the introducing sentence.

The reply may be in any language. A Chinese question often ends in 吗 or 呢 instead of "?", and
its lists use 1、 or （1） as well as 1.

Reply with compact JSON only — no whitespace, no prose, no code fences:
{"questions":[{"question":"...","header":"...","multiSelect":false,"options":[{"label":"...","description":"..."}]}]}

Rules:
- At most ${maxQuestions} questions; pick the ${maxQuestions} most important if there are more.
- "question" repeats it verbatim in its own language; for a bare list of next steps write the
  implied question ("Which step should I take next?").
- One option per list item, the item text as "label".
- A one-item list cannot fill a question: ask whether to do it with "Yes" and "No".
- "header": at most 10 characters. "description": one sentence, at most 60 characters, no ending
  punctuation.
- Each "label": at most ${MAX_LABEL_LENGTH} characters, a concrete answer, not a restatement of the
  question.
- Never emit "Other" or "Type something.". Emit exactly the keys shown, never "preview".
- If the fragments ask nothing, reply {"questions":[]}.`;
}
