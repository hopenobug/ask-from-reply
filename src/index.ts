/**
 * ask-from-reply — turn the questions in the assistant's latest reply into an interactive
 * questionnaire, then hand the answers back to the main conversation.
 *
 * Extraction happens in a side `modelRegistry.complete()` call, so the main transcript is
 * never touched by it. The dialog is a vendored copy of rpiv's questionnaire (see
 * `vendor/`), because that package registers its tool as `model-only` and exports no UI.
 */
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { CancellableLoader, type TUI } from "@earendil-works/pi-tui";
import type { QuestionnaireResult } from "./vendor/tool/types.ts";
import { readConfig, splitModelSpec } from "./config.ts";
import { extractQuestions, lastAssistantText } from "./extract.ts";
import { formatAnswersCompact } from "./format.ts";
import { askQuestions } from "./questionnaire.ts";

const SHORTCUT = "ctrl+shift+a";
const COMMAND = "ask-from-reply";

/**
 * Run `work` under a spinner the user can abort with Esc or Ctrl+C.
 *
 * Returns `undefined` when aborted, so the caller treats a cancel as a cancel and not as
 * a failure worth reporting.
 */
/** Status-line key for the hosts that cannot draw the loader overlay. */
const STATUS_KEY = "ask-from-reply";

async function withLoader<T>(
	ctx: ExtensionContext,
	message: string,
	work: (signal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
	let aborted = false;
	// Hosts that cannot render `ctx.ui.custom` (RPC/ACP: Zed, Paseo, VS Code pendant)
	// resolve `undefined` without ever calling the factory. The extraction must still run
	// there, so the factory records that it started and a skipped mount re-runs the work
	// without a spinner. `started === false` proves `work` never began, so this cannot
	// duplicate side effects.
	let started = false;
	const result = await ctx.ui.custom<T | undefined>(
		(tui: TUI, _theme, _keybindings, done) => {
			started = true;
			const loader = new CancellableLoader(
				tui,
				(text: string) => `\u001b[36m${text}\u001b[39m`,
				(text: string) => text,
				message,
			);
			loader.onAbort = () => {
				aborted = true;
				done(undefined);
			};
			loader.start();
			void work(loader.signal).then(
				(value) => {
					loader.stop();
					done(value);
				},
				() => {
					loader.stop();
					done(undefined);
				},
			);
			return loader;
		},
		{ overlay: false },
	);
	if (!started) {
		// Same call, no spinner: those hosts have no overlay to draw one in, and starting the
		// work silently made a slow extraction look like a dead keybinding. `setStatus` is what
		// they do render (the RPC/print equivalents of the TUI status line), so the progress text
		// goes there and is cleared on every exit path.
		ctx.ui.setStatus(STATUS_KEY, message);
		try {
			return await work(new AbortController().signal).catch(() => undefined);
		} finally {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	}
	return aborted ? undefined : result;
}

/**
 * The model that extracts the questions: the configured `provider/modelId` when present,
 * otherwise the session model. A configured-but-missing model falls back loudly — it is a
 * typo worth surfacing, not a reason to refuse to run.
 */
function extractionModelFor(ctx: ExtensionContext, spec: string | undefined) {
	if (!spec) return ctx.model;
	const parts = splitModelSpec(spec);
	const found = parts ? ctx.modelRegistry.find(parts.provider, parts.modelId) : undefined;
	if (found) return found;
	const fallback = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "the session model";
	ctx.ui.notify(`extractionModel "${spec}" is not available; using ${fallback}`, "warning");
	return ctx.model;
}

async function run(api: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;
	if (!ctx.isIdle()) {
		ctx.ui.notify("Wait for the current turn to finish before extracting questions", "warning");
		return;
	}

	// Settings live next to pi's own settings.json, or wherever the env override points.
	const { config, warning } = readConfig(getAgentDir());
	if (warning) ctx.ui.notify(`ask-from-reply config: ${warning}`, "warning");

	const reply = lastAssistantText(ctx);
	if (!reply) {
		ctx.ui.notify("No assistant reply with text to extract questions from", "warning");
		return;
	}

	// Resolved before the loader: a bad setting notifies in the chat area, which should not
	// happen while a spinner owns the screen.
	const extractionModel = extractionModelFor(ctx, config.extractionModel);

	const extraction = await withLoader(ctx, "Extracting questions…", (signal) =>
		extractQuestions(ctx, reply, signal, extractionModel, config),
	);
	if (!extraction) {
		ctx.ui.notify("Question extraction cancelled", "info");
		return;
	}
	if (extraction.kind === "none") {
		ctx.ui.notify("The last reply asks no questions", "info");
		return;
	}
	if (extraction.kind === "failed") {
		ctx.ui.notify(`Could not extract questions: ${extraction.reason}`, "error");
		return;
	}

	// One renderer for both directions: the Submit tab previews the answers with it, and the
	// message sent afterwards is built by the same call — the preview cannot drift. The full
	// reply is passed (not the extraction fragments): the compact envelope matches answers
	// back to the reply's own option numbering, which needs the text the user saw.
	const renderAnswers = (answers: QuestionnaireResult): string =>
		formatAnswersCompact(answers, extraction.params, reply);

	const result = await askQuestions(ctx, extraction.params, renderAnswers);
	if (!result) {
		ctx.ui.notify("This host cannot render the questionnaire", "error");
		return;
	}
	if (result.cancelled) {
		ctx.ui.notify("Questionnaire cancelled", "info");
		return;
	}
	if (result.answers.length === 0) {
		ctx.ui.notify("No answers were recorded", "warning");
		return;
	}

	const message = renderAnswers(result);
	if (message.length === 0) {
		ctx.ui.notify("No usable answers were recorded", "warning");
		return;
	}

	// `submit: "editor"` parks the text in the input box so it can be edited before sending.
	// Only the TUI has an editor to park it in; elsewhere the answers would be lost, so the
	// configured mode degrades to a send instead of silently doing nothing.
	if (config.submit === "editor") {
		if (ctx.mode === "tui") {
			ctx.ui.setEditorText(message);
			return;
		}
		ctx.ui.notify("submit \"editor\" needs the TUI; sending the answers instead", "info");
	}
	api.sendUserMessage(message);
}

export default function askFromReply(api: ExtensionAPI): void {
	api.registerShortcut(SHORTCUT, {
		description: "Extract questions from the last reply and answer them in a dialog",
		handler: (ctx) => run(api, ctx),
	});
	api.registerCommand(COMMAND, {
		description: "Extract questions from the last reply and answer them in a dialog",
		handler: async (_args, ctx) => {
			await run(api, ctx);
		},
	});
}

