/**
 * Pull the questions out of the assistant's most recent text reply.
 *
 * This runs as a side request: a throwaway `modelRegistry.complete()` call whose prompt
 * never enters the main transcript, so extraction cannot pollute the conversation the
 * model is actually reasoning about.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, type ExtensionConfig } from "./config.ts";
import { focusQuestionFragments, replyTail } from "./fragments.ts";
import { systemPrompt } from "./prompt.ts";
import { checkQuestionShape } from "./question-shape.ts";
import { normalizeQuestionParams } from "./vendor/tool/normalize-params.ts";
import type { QuestionParams } from "./vendor/tool/types.ts";
import { validateQuestionnaire } from "./vendor/tool/validate-questionnaire.ts";

/** The config keys that shape one extraction request. */
export type ExtractOptions = Pick<
	ExtensionConfig,
	"extractionTimeoutMs" | "maxOptions" | "maxQuestions" | "replyTailChars"
>;

export const DEFAULT_EXTRACT_OPTIONS: ExtractOptions = {
	extractionTimeoutMs: DEFAULT_CONFIG.extractionTimeoutMs,
	maxOptions: DEFAULT_CONFIG.maxOptions,
	maxQuestions: DEFAULT_CONFIG.maxQuestions,
	replyTailChars: DEFAULT_CONFIG.replyTailChars,
};

/** Concatenated text blocks of the last assistant message that has any text. */
export function lastAssistantText(ctx: ExtensionContext): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i -= 1) {
		const entry = branch[i];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const text = entry.message.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();
		if (text.length > 0) return text;
	}
	return undefined;
}

/** Strip a ```json fence if the model wrapped its JSON in one anyway. */
function unfence(raw: string): string {
	const trimmed = raw.trim();
	const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i.exec(trimmed);
	return fenced ? fenced[1].trim() : trimmed;
}

/** Pull the outermost JSON object out of a reply that may still carry prose. */
function extractJsonObject(raw: string): string | undefined {
	const unfenced = unfence(raw);
	const start = unfenced.indexOf("{");
	const end = unfenced.lastIndexOf("}");
	if (start === -1 || end <= start) return undefined;
	return unfenced.slice(start, end + 1);
}

/** `60000` reads badly in a notification; `60s` does not. */
function formatDuration(ms: number): string {
	return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

export type ExtractOutcome =
	| { kind: "ok"; params: QuestionParams }
	| { kind: "none" }
	| { kind: "failed"; reason: string };

function parseQuestions(raw: string, options: ExtractOptions): ExtractOutcome {
	const json = extractJsonObject(raw);
	if (json === undefined) return { kind: "failed", reason: "the model did not return JSON" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return { kind: "failed", reason: "the model returned malformed JSON" };
	}
	// Shape first: the normalizer and validator below both assume well-formed input, so a
	// missing `options` array would otherwise surface as a TypeError message.
	const shape = checkQuestionShape(parsed);
	if (!shape.ok) return { kind: "failed", reason: shape.reason };
	if (shape.params.questions.length === 0) return { kind: "none" };
	// Round-trip through the vendor normalizer/validator so a sloppy model output cannot
	// reach the dialog: it rejects reserved labels, duplicate questions, and bad counts.
	const params = normalizeQuestionParams(shape.params);
	const validation = validateQuestionnaire(params, {
		maxOptions: options.maxOptions,
		maxQuestions: options.maxQuestions,
	});
	if (!validation.ok) return { kind: "failed", reason: validation.message };
	return { kind: "ok", params };
}

/**
 * Ask a side model call to extract questions from `reply`.
 *
 * `signal` aborts the request (the caller wires it to Esc / Ctrl+C); an abort resolves to
 * `{ kind: "none" }` rather than an error so the caller can treat it as a plain cancel.
 *
 * `model` defaults to the session model; the caller may pass another one (the config's
 * `extractionModel`) so extraction does not have to run on the model that wrote the reply.
 *
 * `options` mirrors the config file: it caps the question and option counts, decides how
 * much of the reply the model sees, and bounds how long the request may take.
 */
export async function extractQuestions(
	ctx: ExtensionContext,
	reply: string,
	signal: AbortSignal,
	model: NonNullable<ExtensionContext["model"]> | undefined = ctx.model,
	options: ExtractOptions = DEFAULT_EXTRACT_OPTIONS,
): Promise<ExtractOutcome> {
	if (!model) return { kind: "failed", reason: "no model is selected" };
	// Two independent ways to abort: the caller (Esc) and the timeout below.
	// `AbortSignal.any` keeps both, and `timedOut` records which one fired.
	const timeoutController = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		timeoutController.abort();
	}, options.extractionTimeoutMs);
	const timedOutOutcome = (): ExtractOutcome => ({
		kind: "failed",
		reason: `the extraction timed out after ${formatDuration(options.extractionTimeoutMs)}`,
	});
	try {
		const message = await ctx.modelRegistry.complete(
			model,
			{
				systemPrompt: systemPrompt(options),
				messages: [
					{
						role: "user",
						content: focusQuestionFragments(replyTail(reply, options.replyTailChars)),
						timestamp: Date.now(),
					},
				],
			},
			{ signal: AbortSignal.any([signal, timeoutController.signal]) },
		);
		// Aborting a stream ends it quietly, with whatever the model had said so far, so the
		// timeout has to be checked before the (usually empty) answer is parsed as JSON.
		if (timedOut) return timedOutOutcome();
		const raw = message.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		return parseQuestions(raw, options);
	} catch (error) {
		if (signal.aborted) return { kind: "none" };
		if (timedOut) return timedOutOutcome();
		return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
	} finally {
		clearTimeout(timer);
	}
}
