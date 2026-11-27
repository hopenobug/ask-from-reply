/**
 * Mount the vendored rpiv questionnaire dialog for a questionnaire this extension built
 * itself (no tool call, no external answer channel).
 *
 * Mirrors upstream `mountQuestionnaire` / `makeSessionFactory` with the pieces this fork
 * does not need removed: no `OpenQuestionnaire` first-answer-wins gate (there is no
 * inbound `rpiv:ask-user:answer` channel) and no external-editor bridge for inline input.
 */
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type KeyId, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import {
	COLLAPSE_KEY_OFF,
	DEFAULT_COLLAPSE_KEY,
	DEFAULT_NOTES_KEY,
	formatKeySpecForDisplay,
} from "./vendor/config.ts";
import { buildItemsForQuestion } from "./vendor/items.ts";
import {
	mustYieldInlineSlot,
	resolvePresentation,
	rowBudgetForHost,
	STACKED_OVERLAY_PRESENTATION,
	YIELD_TO_OVERLAY,
	type Presentation,
} from "./vendor/presentation.ts";
import { hasDialogUI, runRpcQuestionnaire } from "./vendor/rpc-fallback.ts";
import {
	QuestionnaireSession,
	type QuestionnaireSessionComponent,
} from "./vendor/state/questionnaire-session.ts";
import type { QuestionParams, QuestionnaireResult } from "./vendor/tool/types.ts";

const COLLAPSE_KEY = DEFAULT_COLLAPSE_KEY;
const NOTES_KEY = DEFAULT_NOTES_KEY;

/** Stand-in for a mount that resolved before mounting (Pi discards it unmounted). */
const INERT_COMPONENT: QuestionnaireSessionComponent = {
	render: () => [],
	invalidate: () => {},
	handleInput: () => {},
};

interface MountRefs {
	session: QuestionnaireSession | null;
	overlayHandle: OverlayHandle | undefined;
}

/**
 * Raw terminal listener that toggles the collapsed overlay. pi-tui routes no input to a
 * hidden overlay's `component.handleInput`, so the collapse key is only reachable through
 * this hook. Returns undefined when the host has no raw input hook — the session then
 * falls back to a visible one-line collapsed row.
 */
function registerCollapseKeyListener(ctx: ExtensionContext, refs: MountRefs): (() => void) | undefined {
	if (COLLAPSE_KEY === COLLAPSE_KEY_OFF || typeof ctx.ui.onTerminalInput !== "function") return undefined;
	let announced = false;
	return ctx.ui.onTerminalInput((data) => {
		const handle = refs.overlayHandle;
		if (!handle) return undefined;
		if (!handle.isHidden() && !handle.isFocused()) return undefined;
		if (!matchesKey(data, COLLAPSE_KEY as KeyId)) return undefined;
		refs.session?.toggleCollapsedExternal();
		if (handle.isHidden() && !announced) {
			announced = true;
			ctx.ui.notify(`Questionnaire hidden — press ${formatKeySpecForDisplay(COLLAPSE_KEY)} to reopen`, "info");
		}
		return { consume: true };
	});
}

/** Renders the text the caller will send, for the Submit tab's live preview. */
export type SubmissionPreview = (result: QuestionnaireResult) => string;

async function mountQuestionnaire(
	ctx: ExtensionContext,
	params: QuestionParams,
	itemsByTab: ReturnType<typeof buildItemsForQuestion>[],
	presentation: Presentation,
	previewSubmission: SubmissionPreview | undefined,
): Promise<QuestionnaireResult | undefined> {
	const refs: MountRefs = { session: null, overlayHandle: undefined };
	const removeListener = presentation.hideOnCollapse ? registerCollapseKeyListener(ctx, refs) : undefined;
	const canReopenWhileHidden = removeListener !== undefined;
	try {
		return await ctx.ui.custom<QuestionnaireResult>(
			(tui: TUI, theme: Theme, keybindings, done) => {
				if (!presentation.overlay && mustYieldInlineSlot(tui)) {
					done(YIELD_TO_OVERLAY);
					return INERT_COMPONENT;
				}
				const session = new QuestionnaireSession({
					tui,
					theme,
					params,
					itemsByTab,
					done,
					keybindings,
					// Upstream bridges this to Pi's external editor; this fork keeps inline editing.
					editInput: async () => undefined,
					collapseKey: COLLAPSE_KEY,
					notesKey: NOTES_KEY,
					canReopenWhileHidden,
					rowBudget: rowBudgetForHost(tui.terminal, presentation.rowBudget),
					previewSubmission,
				});
				refs.session = session;
				return session.component;
			},
			presentation.overlay
				? {
						overlay: true,
						overlayOptions: {
							anchor: "bottom-center",
							width: "100%",
							maxHeight: "100%",
							margin: { left: 0, right: 0, bottom: 0 },
						},
						onHandle: (handle: OverlayHandle) => {
							refs.overlayHandle = handle;
							refs.session?.setOverlayHandle(handle);
						},
					}
				: { overlay: false },
		);
	} finally {
		removeListener?.();
	}
}

/**
 * Present `params` to the user and resolve with their answers.
 *
 * `cancelled: true` means the user pressed Esc (or dismissed an RPC dialog) — a real
 * decline. `undefined` uniquely means "this host cannot render the questionnaire at all",
 * which is never a decline, so callers must report it honestly instead of assuming one.
 */
export async function askQuestions(
	ctx: ExtensionContext,
	params: QuestionParams,
	/**
	 * Renders the text the answers will be sent as. The Submit tab shows it verbatim below
	 * the answer summary, so what the user reviews is exactly what leaves the dialog.
	 * Hosts without a custom component (RPC) send no preview — they have no Submit tab.
	 */
	previewSubmission?: SubmissionPreview,
): Promise<QuestionnaireResult | undefined> {
	if (!ctx.hasUI) return undefined;

	// RPC/ACP hosts (Zed, Paseo, VS Code pendant) cannot render `ctx.ui.custom`; they get
	// the native select/input walker, which produces the same result envelope.
	if (ctx.mode === "rpc" && hasDialogUI(ctx.ui)) return await runRpcQuestionnaire(ctx.ui, params);

	const itemsByTab = params.questions.map(buildItemsForQuestion);
	let presentation = resolvePresentation();
	let result = await mountQuestionnaire(ctx, params, itemsByTab, presentation, previewSubmission);
	if (result === YIELD_TO_OVERLAY) {
		presentation.release?.();
		presentation = STACKED_OVERLAY_PRESENTATION;
		result = await mountQuestionnaire(ctx, params, itemsByTab, presentation, previewSubmission);
	}
	presentation.release?.();

	// `undefined` means the host could not render the custom component. RPC builds that
	// predate `ctx.mode` land here; retry with the dialog walker before giving up.
	if (result === undefined && hasDialogUI(ctx.ui)) return await runRpcQuestionnaire(ctx.ui, params);
	return result;
}
