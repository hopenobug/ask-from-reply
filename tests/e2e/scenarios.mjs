/**
 * The RPC end-to-end scenarios: one real pi process per scenario, in its own empty
 * working directory, driven over the JSONL protocol.
 *
 * The model is local and scripted (see `fake-model.mjs`), so both halves of a scenario are
 * fixed: the assistant reply the extension reads, and the questionnaire JSON the extractor
 * returns. That makes the failure paths reachable at all — a real model will not reliably
 * emit malformed JSON, overshoot the configured caps, or hang — and it lets a scenario
 * assert on exactly what reached the wire (the truncated tail, the caps in the prompt).
 *
 * What is *not* fixed is the dialog side: scenarios answer whatever the extension actually
 * asks, and only the answer envelope contract is asserted (`assertCompactEnvelope`).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_ENV, CONFIG_FILE } from "../../src/config.ts";
import { lastUserText, startFakeModel, systemText } from "./fake-model.mjs";
import { RpcSession, sleep, withEmptyWorkspace } from "./harness.mjs";

/** How long a scenario may take end to end. */
export const SCENARIO_TIMEOUT = 180_000;
/** Poll interval while waiting for dialogs and the follow-up user message. */
const POLL_MS = 250;

/** The command under test. */
const TRIGGER = "/ask-from-reply";
const LOADER_STATUS = "Extracting questions…";

const SENTINEL = /^\d+\.\s+Type something\.$/;
/** One numbered option line as the RPC dialog title / select option list renders it. */
const OPTION_LINE = /^(\d+)\.\s+(.+?)(?: — .*)?$/;

/** Text of the option lines in either a `select` options array or an `input` title. */
function optionNumbers(request) {
	if (Array.isArray(request.options)) {
		return request.options
			.filter((line) => OPTION_LINE.test(line) && !SENTINEL.test(line))
			.map((line) => Number(OPTION_LINE.exec(line)[1]));
	}
	const title = typeof request.title === "string" ? request.title : "";
	return title
		.split("\n")
		.filter((line) => OPTION_LINE.test(line))
		.map((line) => Number(OPTION_LINE.exec(line)[1]));
}

/**
 * User texts that came from the conversation, minus the command trigger itself (a
 * mis-dispatched command would land in the transcript as that literal text).
 */
async function conversationTexts(session) {
	return (await session.userTexts()).filter((text) => text !== TRIGGER);
}

/**
 * What the extractor saw on its last call: the fragments it was handed and the system
 * prompt it was given. Reading the fake's request log once here keeps every scenario's
 * `check` from reaching into the request body itself.
 */
function lastExtraction(fake) {
	const body = fake.extractionRequests().at(-1)?.body;
	return { seen: lastUserText(body), prompt: systemText(body) };
}

function requireMethod(request, method, hint) {
	assert.equal(
		request.method,
		method,
		`expected a ${method} dialog (${hint}), got "${request.method}": ${JSON.stringify(request).slice(0, 400)}`,
	);
}

/** A questionnaire as JSON, the way the extractor is supposed to answer. */
export function questionsJson(questions) {
	return JSON.stringify({ questions });
}

/** One single-select question with three options, in the reply's own numbering order. */
export function cacheQuestions({ multiSelect = false } = {}) {
	return [
		{
			question: "Which cache should we use?",
			header: "Cache",
			multiSelect,
			options: [
				{ label: "No cache", description: "Read from disk every run" },
				{ label: "Memory cache with TTL", description: "Keep results in RAM" },
				{ label: "Disk cache across runs", description: "Reuse results between runs" },
			],
		},
	];
}

/** The assistant reply that carries the numbering `formatAnswersCompact` can echo. */
export const CACHE_REPLY = [
	"Which cache should we use?",
	"",
	"1. No cache",
	"2. Memory cache with TTL",
	"3. Disk cache across runs",
].join("\n");

/**
 * A reply that asks nothing with a "?": it lists the numbered next steps instead. The
 * extractor has to treat the list as the question, with the introducing sentence above it.
 */
const NEXT_STEPS_REPLY = [
	"The refactor is done. Next steps:",
	"",
	"1. Run the full test suite",
	"2. Split the extractor module",
	"3. Commit the change",
].join("\n");

/**
 * A reply whose numbered list states facts, not choices: a findings report. It must reach the
 * extractor, and the prompt must arm the model to decline it — every status report would
 * otherwise pop a dialog.
 */
const FINDINGS_REPLY = [
	"I audited the module. It has three problems:",
	"",
	"1. a memory leak in A",
	"2. a race in B",
	"3. dead code in C",
].join("\n");

/**
 * A Chinese reply that asks with a choice-naming colon line and a bullet list of options, plus
 * a `吗` question without a question mark: both shapes have to reach the extractor.
 */
const CHINESE_REPLY = [
	"我先看了下代码，问题不大。",
	"",
	"用哪个缓存：",
	"",
	"- 不缓存",
	"- 内存缓存带 TTL",
	"- 磁盘缓存",
	"",
	"要不要我顺手把测试也拆了",
].join("\n");

/**
 * A reply whose question sits far past the tail window: the extractor must only see the
 * tail. Plain ASCII, so `slice(-120)` below is the same window `replyTail` cuts.
 */
const LONG_REPLY = `${"Z".repeat(300)} Would you like tea?`;
const LONG_REPLY_TAIL = LONG_REPLY.slice(-120);

/**
 * Answer dialogs until the command handler finishes, then read back what it sent.
 *
 * The handler only replies to the RPC prompt once the whole questionnaire is over, so its
 * promise is the "done" signal; the follow-up user message is looked for afterwards, since
 * a cancelled or unanswered questionnaire sends nothing at all.
 */
async function drive(session, scenario, baselineUsers, triggerPromise) {
	const dialogs = [];
	const deadline = Date.now() + (scenario.timeout ?? SCENARIO_TIMEOUT);
	let handled = 0;
	let trigger = null;
	triggerPromise.then((response) => {
		trigger = response;
	});
	for (;;) {
		if (session.exited) {
			throw new Error(`pi exited mid-scenario: ${JSON.stringify(session.exitInfo)}\n${session.stderr}`);
		}
		if (Date.now() > deadline) {
			throw new Error(
				`scenario timeout after ${scenario.timeout ?? SCENARIO_TIMEOUT}ms; dialogs so far: ${dialogs.length}; ` +
					`notifications: ${JSON.stringify(session.notifications())}`,
			);
		}
		const requests = session.uiRequests;
		if (handled < requests.length) {
			const request = requests[handled];
			handled += 1;
			if (request.method !== "select" && request.method !== "input" && request.method !== "confirm") continue;
			const reply = await scenario.answer(request, { dialogs });
			session.respond(request.id, reply);
			dialogs.push({ method: request.method, title: request.title, options: request.options, reply });
			continue;
		}
		if (trigger) break;
		await sleep(POLL_MS);
	}
	// `sendUserMessage` appends before the handler returns, but the transcript snapshot is a
	// separate round trip — give it a moment to include the message.
	let users = await conversationTexts(session);
	for (let attempt = 0; attempt < 12 && users.length <= baselineUsers; attempt += 1) {
		await sleep(POLL_MS);
		users = await conversationTexts(session);
	}
	return { dialogs, trigger, message: users[baselineUsers] ?? null, userTexts: users };
}

/** Write a throwaway config file for the child and point `ASK_FROM_REPLY_CONFIG` at it. */
function writeScenarioConfig(config) {
	const dir = mkdtempSync(join(tmpdir(), "afr-cfg-"));
	const path = join(dir, CONFIG_FILE);
	writeFileSync(path, JSON.stringify(config));
	return { env: { [CONFIG_ENV]: path }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * The fake model's script: the main line answers with `scenario.reply`, the extractor with
 * `scenario.extract` (a string, or a function returning `{ text, delayMs }`).
 */
function modelScript(scenario) {
	return ({ kind }) => {
		if (kind === "main") return { text: scenario.reply };
		return typeof scenario.extract === "function" ? scenario.extract() : { text: scenario.extract };
	};
}

/**
 * Write the settings where the extension looks by default: the agent directory that also
 * holds `settings.json`, pointed at `<cwd>/agent` so nothing real is touched.
 */
function writeAgentDirConfig(cwd, config) {
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir);
	writeFileSync(join(agentDir, CONFIG_FILE), JSON.stringify(config));
	return {
		env: { PI_CODING_AGENT_DIR: agentDir, [CONFIG_ENV]: "" },
		path: join(agentDir, CONFIG_FILE),
	};
}

/** Prime the transcript with the scripted assistant reply, then run the command on it. */
export async function runScenario(scenario) {
	return await withEmptyWorkspace(async (cwd) => {
		const settings = scenario.config === undefined ? undefined : writeScenarioConfig(scenario.config);
		const agentDir = scenario.agentDirConfig === undefined ? undefined : writeAgentDirConfig(cwd, scenario.agentDirConfig);
		const fake = await startFakeModel({ cwd, respond: modelScript(scenario) });
		const session = new RpcSession({
			cwd,
			env: { ...agentDir?.env, ...settings?.env, ...fake.env },
			args: fake.args,
		});
		await session.start();
		try {
			const priming = await session.prompt(scenario.prompt ?? "Anything?");
			assert.equal(priming.success, true, `the priming prompt was rejected: ${JSON.stringify(priming)}`);
			await session.waitForSettled({ timeout: 180_000 });
			const reply = await session.lastAssistantText();
			assert.equal(reply.trim(), scenario.reply.trim(), "the scripted reply never reached the transcript");

			const baselineUsers = (await conversationTexts(session)).length;
			// Not awaited yet: the handler answers only once the questionnaire is over.
			const triggerPromise = session.prompt(TRIGGER).then(
				(response) => response,
				(error) => ({ error }),
			);

			const observation = await drive(session, scenario, baselineUsers, triggerPromise);
			const trigger = observation.trigger;
			if (trigger.error) throw trigger.error;
			assert.equal(trigger.success, true, `the command prompt was rejected: ${JSON.stringify(trigger)}`);
			assert.equal(
				trigger.data?.disposition,
				"handled",
				`${TRIGGER} was not dispatched as an extension command (disposition ${trigger.data?.disposition}). ` +
					`The extension did not load; stderr:\n${session.stderr}`,
			);

			// Every path goes through the loader, and hosts without an overlay only have this
			// status line to show — so it must be set and then cleared.
			const statuses = session.statusLines();
			assert.ok(
				statuses.includes(LOADER_STATUS),
				`no "${LOADER_STATUS}" status line was emitted; got ${JSON.stringify(statuses)}`,
			);
			assert.equal(
				statuses.at(-1),
				undefined,
				`the status line was left set: ${JSON.stringify(statuses)}`,
			);

			const result = {
				...observation,
				reply,
				fake,
				notifications: session.notifications(),
				stderr: session.stderr,
				cwd,
			};
			scenario.check(result);
			return result;
		} finally {
			await session.abort();
			await session.stop();
			settings?.cleanup();
			await fake.close();
		}
	});
}

const NO_LEGACY_PREFIX = "Answers (";
const NO_SKIPPED_LINE = "(skipped)";
const NUMBER_VALUE = /^\d+(, \d+)*( \| .+)?$/;

/**
 * Parse one compact answer line back into its parts. The line is
 * `key + (" → " | ": ") + value + (" | note: " + note)?`, and the key is the extracted
 * question header, which may itself contain spaces and punctuation — so the split points
 * come from the right: the note suffix, then the marker the formatter chose.
 */
export function parseAnswerLine(line) {
	const noteAt = line.lastIndexOf(" | note: ");
	const body = noteAt >= 0 ? line.slice(0, noteAt) : line;
	const note = noteAt >= 0 ? line.slice(noteAt + " | note: ".length) : null;
	const arrowAt = body.lastIndexOf(" → ");
	if (arrowAt > 0) {
		return { line, key: body.slice(0, arrowAt), marker: "→", value: body.slice(arrowAt + 3), note };
	}
	const colonAt = body.indexOf(": ");
	if (colonAt > 0) {
		return { line, key: body.slice(0, colonAt), marker: ":", value: body.slice(colonAt + 2), note };
	}
	return null;
}

/**
 * Assertions shared by every scenario: the message is a bare list of compact answer
 * lines — no legacy `Answers (Qn = …)` header, no `(skipped)` rows, no duplicated keys.
 */
export function assertCompactEnvelope(message, { maxLines = 4 } = {}) {
	assert.equal(typeof message, "string", "the questionnaire sent no user message");
	assert.ok(message.trim().length > 0, "the questionnaire message was empty");
	assert.ok(!message.includes(NO_LEGACY_PREFIX), `legacy header leaked: ${message}`);
	assert.ok(!message.includes(NO_SKIPPED_LINE), `a skipped row leaked: ${message}`);
	const lines = message.split("\n").filter((line) => line.length > 0);
	assert.ok(lines.length > 0, `no answer lines in: ${JSON.stringify(message)}`);
	assert.ok(lines.length <= maxLines, `expected at most ${maxLines} lines, got ${lines.length}:\n${message}`);
	const keys = new Set();
	const parsed = lines.map((line) => {
		const answer = parseAnswerLine(line);
		assert.ok(answer, `unexpected answer line: ${JSON.stringify(line)}`);
		assert.ok(answer.key.length > 0, `missing answer key: ${JSON.stringify(line)}`);
		assert.ok(answer.value.length > 0, `missing answer value: ${JSON.stringify(line)}`);
		assert.ok(
			answer.marker === ":" || NUMBER_VALUE.test(answer.value),
			`a "→" answer must be a number list, got ${JSON.stringify(answer.value)}`,
		);
		assert.ok(!keys.has(answer.key), `duplicate answer key "${answer.key}" in:\n${message}`);
		keys.add(answer.key);
		return answer;
	});
	return parsed;
}

/** The extension refused to build a questionnaire; assert the reason it gave the user. */
function assertExtractionRefused({ message, notifications }, expected) {
	assert.equal(message, null, `a refused extraction must not send a message, got:\n${message}`);
	assert.ok(
		notifications.some((text) => text.includes("Could not extract questions") && text.includes(expected)),
		`expected a "Could not extract questions: …${expected}…" notification, got ${JSON.stringify(notifications)}`,
	);
}

export const SCENARIOS = [
	{
		name: "a numbered list of next steps is asked as one multi-select question",
		reply: NEXT_STEPS_REPLY,
		extract: questionsJson([
			{
				question: "Which steps should I take next?",
				header: "Next",
				multiSelect: true,
				options: [
					{ label: "Run the full test suite", description: "Check nothing regressed" },
					{ label: "Split the extractor module", description: "Move the fragment filter out" },
					{ label: "Commit the change", description: "Land it on main" },
				],
			},
		]),
		answer(request) {
			// Steps can be done together, so the question is multi-select: two of the three.
			requireMethod(request, "input", "a multi-select question (multiSelect: true)");
			const numbers = optionNumbers(request);
			assert.ok(numbers.length >= 3, `expected at least 3 option numbers in the title: ${request.title}`);
			return { value: `${numbers[0]},${numbers[2]}` };
		},
		check({ message, fake }) {
			// The fragments the extractor saw must carry the numbered list, not just the prose.
			const { seen, prompt } = lastExtraction(fake);
			for (const item of ["1. Run the full test suite", "2. Split the extractor module", "3. Commit the change"]) {
				assert.ok(seen.includes(item), `the extractor never saw ${JSON.stringify(item)}: ${JSON.stringify(seen)}`);
			}
			assert.ok(seen.includes("Next steps"), `the introducing line was dropped: ${JSON.stringify(seen)}`);
			assert.ok(
				prompt.includes("numbered list"),
				`the prompt never tells the model a numbered list is a question: ${prompt.slice(0, 600)}`,
			);
			assert.ok(
				prompt.includes("multi-select"),
				`the prompt never tells the model a list of next steps is multi-select: ${prompt.slice(0, 900)}`,
			);
			const [line] = assertCompactEnvelope(message, { maxLines: 1 });
			// The question text is the model's, not the reply's, so it cannot anchor the numbered
			// echo; the answer degrades to the labels — never to a wrong number.
			assert.equal(line.marker, ":", `an unanchored list answer stays textual: ${line.line}`);
			assert.equal(
				line.value,
				"Run the full test suite, Commit the change",
				`both picked steps are echoed, in list order: ${line.line}`,
			);
		},
	},
	{
		name: "a numbered list of findings is not mistaken for a question",
		reply: FINDINGS_REPLY,
		extract: questionsJson([]),
		answer() {
			throw new Error("a findings list must not open a dialog");
		},
		check({ message, notifications, fake }) {
			assert.equal(message, null, `nothing to ask means no message, got:\n${message}`);
			assert.ok(
				notifications.some((text) => text.includes("The last reply asks no questions")),
				`expected an "asks no questions" notification, got: ${JSON.stringify(notifications)}`,
			);
			// The list still has to reach the extractor: declining is the model's call, not
			// the fragment filter's — the filter cannot tell facts from choices.
			const { seen, prompt } = lastExtraction(fake);
			for (const item of ["1. a memory leak in A", "2. a race in B", "3. dead code in C"]) {
				assert.ok(seen.includes(item), `the extractor never saw ${JSON.stringify(item)}: ${JSON.stringify(seen)}`);
			}
			assert.ok(
				prompt.includes("reports facts"),
				`the prompt never tells the model a findings list is not a question: ${prompt.slice(0, 600)}`,
			);
		},
	},
	{
		name: "a Chinese reply keeps its choice question and its bullet options",
		reply: CHINESE_REPLY,
		extract: questionsJson([
			{
				question: "用哪个缓存？",
				header: "缓存",
				multiSelect: false,
				options: [
					{ label: "不缓存", description: "每次都重新算" },
					{ label: "内存缓存带 TTL", description: "进程内复用" },
					{ label: "磁盘缓存", description: "跨进程复用" },
				],
			},
		]),
		answer(request) {
			requireMethod(request, "select", "one single-select question");
			return { value: request.options[1] };
		},
		check({ message, fake }) {
			const [line] = assertCompactEnvelope(message, { maxLines: 1 });
			assert.equal(line.key, "缓存");
			// The question text is the model's, not the reply's, so the answer degrades to the label.
			assert.equal(line.value, "内存缓存带 TTL");
			// The choice-naming colon line and its bullet list must both reach the extractor: the
			// filter opens the block on the question, and the bullets are its options.
			const { seen } = lastExtraction(fake);
			for (const fragment of ["用哪个缓存：", "- 不缓存", "- 内存缓存带 TTL", "- 磁盘缓存", "要不要我顺手把测试也拆了"]) {
				assert.ok(seen.includes(fragment), `the extractor never saw ${JSON.stringify(fragment)}: ${JSON.stringify(seen)}`);
			}
			// The prose above the question is not part of any block.
			assert.ok(!seen.includes("我先看了下代码"), `prose leaked into the fragments: ${JSON.stringify(seen)}`);
		},
	},
	{
		name: "single select echoes the reply's own option number",
		reply: CACHE_REPLY,
		extract: questionsJson(cacheQuestions()),
		answer(request) {
			requireMethod(request, "select", "one single-select question");
			// Never the trailing "Type something." sentinel; the 2nd real option.
			const real = request.options.slice(0, -1);
			return { value: real[1] ?? real[0] };
		},
		check({ message, dialogs }) {
			assert.equal(dialogs.length, 1, "expected exactly one single-select dialog");
			const [line] = assertCompactEnvelope(message, { maxLines: 1 });
			assert.equal(line.marker, "→", `a listed option is answered by number: ${line.line}`);
			assert.equal(line.value, "2", `the 2nd listed option is number 2: ${line.line}`);
			assert.equal(line.key, "Cache", `the header becomes the key: ${line.line}`);
		},
	},
	{
		name: "multi select with selected numbers and custom text",
		reply: CACHE_REPLY,
		extract: questionsJson(cacheQuestions({ multiSelect: true })),
		answer(request) {
			requireMethod(request, "input", "a multi-select question (multiSelect: true)");
			const numbers = optionNumbers(request);
			assert.ok(numbers.length >= 3, `expected at least 3 option numbers in the title: ${request.title}`);
			return { value: `${numbers[0]},${numbers[2]}; custom text` };
		},
		check({ message }) {
			const [line] = assertCompactEnvelope(message, { maxLines: 4 });
			assert.equal(line.value, "1, 3 | custom text", `expected the picked numbers then the custom text: ${line.line}`);
		},
	},
	{
		name: "custom answer via the Type something row",
		reply: 'How should we name the module?\n\n1. By its role\n2. By its owner',
		extract: questionsJson([
			{
				question: "How should we name the module?",
				header: "Name",
				multiSelect: false,
				options: [
					{ label: "By its role", description: "e.g. Extractor" },
					{ label: "By its owner", description: "e.g. TeamCache" },
				],
			},
		]),
		answer(request) {
			if (request.method === "select") {
				const sentinel = request.options.find((line) => SENTINEL.test(line));
				assert.ok(sentinel, `no "Type something." sentinel in: ${JSON.stringify(request.options)}`);
				return { value: sentinel };
			}
			requireMethod(request, "input", "the Type something follow-up");
			return { value: "PascalCase" };
		},
		check({ message }) {
			const [line] = assertCompactEnvelope(message, { maxLines: 1 });
			assert.equal(line.marker, ":", `custom answers are never numbered: ${line.line}`);
			assert.equal(line.value, "PascalCase", `custom answers stay verbatim: ${line.line}`);
		},
	},
	{
		name: "user cancels the first dialog",
		reply: CACHE_REPLY,
		extract: questionsJson(cacheQuestions()),
		answer(request) {
			requireMethod(request, "select", "one single-select question");
			return { cancelled: true };
		},
		check({ message, notifications }) {
			assert.equal(message, null, `a cancelled questionnaire must not send a message, got:\n${message}`);
			assert.ok(
				notifications.some((text) => text.includes("Questionnaire cancelled")),
				`expected a "Questionnaire cancelled" notification, got: ${JSON.stringify(notifications)}`,
			);
		},
	},
	{
		name: "extraction finds no questions",
		reply: "Done.",
		extract: questionsJson([]),
		answer() {
			throw new Error("an empty questionnaire must not open a dialog");
		},
		check({ message, notifications }) {
			assert.equal(message, null, `nothing to ask means no message, got:\n${message}`);
			assert.ok(
				notifications.some((text) => text.includes("The last reply asks no questions")),
				`expected an "asks no questions" notification, got: ${JSON.stringify(notifications)}`,
			);
		},
	},
	{
		name: "empty multi-select submission records nothing",
		reply: CACHE_REPLY,
		extract: questionsJson(cacheQuestions({ multiSelect: true })),
		answer(request) {
			requireMethod(request, "input", "a multi-select question (multiSelect: true)");
			return { value: "" };
		},
		check({ message, notifications }) {
			assert.equal(message, null, `an empty selection must not send a message, got:\n${message}`);
			assert.ok(
				notifications.some((text) => text.includes("No usable answers were recorded")),
				`expected a "No usable answers" warning, got: ${JSON.stringify(notifications)}`,
			);
		},
	},
	{
		name: "free text typed over the option list lands as a custom answer",
		reply: CACHE_REPLY,
		extract: questionsJson(cacheQuestions()),
		answer(request) {
			requireMethod(request, "select", "one single-select question");
			return { value: "totally custom words" };
		},
		check({ message }) {
			const [line] = assertCompactEnvelope(message, { maxLines: 1 });
			assert.equal(line.marker, ":", `free text must stay unnumbered: ${line.line}`);
			assert.equal(line.value, "totally custom words", `free text must stay verbatim: ${line.line}`);
		},
	},
	{
		name: 'config submit "editor" falls back to a send outside the TUI',
		// RPC has no input box to park the text in, so the answers must still be sent —
		// silently dropping them would be the one unrecoverable outcome.
		config: { submit: "editor" },
		reply: CACHE_REPLY,
		extract: questionsJson(cacheQuestions()),
		answer(request) {
			requireMethod(request, "select", "one single-select question");
			return { value: request.options[0] };
		},
		check({ message, notifications }) {
			assertCompactEnvelope(message, { maxLines: 1 });
			assert.ok(
				notifications.some((text) => text.includes('submit "editor" needs the TUI')),
				`expected an editor-fallback notification, got: ${JSON.stringify(notifications)}`,
			);
		},
	},
	{
		name: "a configured extraction model that does not exist falls back to the session model",
		config: { extractionModel: "nope/nope-model" },
		reply: CACHE_REPLY,
		extract: questionsJson(cacheQuestions()),
		answer(request) {
			requireMethod(request, "select", "one single-select question");
			return { value: request.options[0] };
		},
		check({ message, notifications }) {
			assertCompactEnvelope(message, { maxLines: 1 });
			assert.ok(
				notifications.some((text) => text.includes('extractionModel "nope/nope-model" is not available')),
				`expected a missing-model warning, got: ${JSON.stringify(notifications)}`,
			);
		},
	},
	{
		// The default location is the agent directory next to pi's settings.json, not the
		// package. Nothing else in the suite reaches it, because every session is handed an
		// `ASK_FROM_REPLY_CONFIG` inside its own workspace — this case clears that override.
		name: "settings are read from the agent directory when nothing overrides them",
		agentDirConfig: { submit: "bogus" },
		reply: CACHE_REPLY,
		extract: questionsJson(cacheQuestions()),
		answer(request) {
			requireMethod(request, "select", "one single-select question");
			return { value: request.options[0] };
		},
		check({ message, notifications, cwd }) {
			assertCompactEnvelope(message, { maxLines: 1 });
			const warning = notifications.find((text) => text.includes("ask-from-reply config:"));
			assert.ok(warning, `no config warning was reported, got: ${JSON.stringify(notifications)}`);
			assert.ok(
				warning.includes(join(cwd, "agent", CONFIG_FILE)),
				`the warning does not name the agent-dir file: ${warning}`,
			);
			assert.ok(warning.includes('"submit" must be "send" or "editor"'), `wrong warning: ${warning}`);
		},
	},
	{
		name: "malformed questionnaire JSON is refused, not guessed at",
		reply: CACHE_REPLY,
		// Balanced braces, invalid JSON: the extractor's text has to reach the parser rather
		// than be thrown away as "no JSON here", which is what the previous case covers.
		extract: '{"questions":[{"question":"Which cache?","header":"Cache",}]}',
		answer() {
			throw new Error("an unparseable extraction must not open a dialog");
		},
		check(result) {
			assertExtractionRefused(result, "returned malformed JSON");
		},
	},
	{
		name: "a question with no options is refused with a readable reason",
		reply: CACHE_REPLY,
		// The shape that used to surface as "Cannot read properties of undefined (reading 'map')".
		extract: '{"questions":[{"question":"Which cache?","header":"Cache"}]}',
		answer() {
			throw new Error("a question with no options must not open a dialog");
		},
		check(result) {
			assertExtractionRefused(result, 'question 1 has no "options" list');
		},
	},
	{
		name: "questions that are not a list are refused, not read as 'no questions'",
		reply: CACHE_REPLY,
		// The model answered, so "The last reply asks no questions" would be a lie.
		extract: '{"questions":"none today"}',
		answer() {
			throw new Error("an unusable extraction must not open a dialog");
		},
		check(result) {
			assertExtractionRefused(result, 'no "questions" list');
			assert.ok(
				!result.notifications.some((text) => text.includes("asks no questions")),
				`a malformed extraction must not be reported as "no questions": ${JSON.stringify(result.notifications)}`,
			);
		},
	},
	{
		name: "a reserved option label is refused",
		reply: CACHE_REPLY,
		extract: questionsJson([
			{
				question: "Which cache should we use?",
				header: "Cache",
				multiSelect: false,
				options: [
					{ label: "No cache", description: "Read from disk every run" },
					{ label: "Other", description: "Something else entirely" },
				],
			},
		]),
		answer() {
			throw new Error("a rejected questionnaire must not open a dialog");
		},
		check(result) {
			assertExtractionRefused(result, "reserved");
		},
	},
	{
		name: "more questions than maxQuestions is refused, and the prompt states the cap",
		config: { maxQuestions: 1 },
		reply: CACHE_REPLY,
		extract: questionsJson([
			...cacheQuestions(),
			{
				question: "Which naming style?",
				header: "Style",
				multiSelect: false,
				options: [
					{ label: "camelCase", description: "Lowercase first letter" },
					{ label: "snake_case", description: "Underscores between words" },
				],
			},
		]),
		answer() {
			throw new Error("an oversized questionnaire must not open a dialog");
		},
		check(result) {
			assertExtractionRefused(result, "At most 1 questions are allowed per invocation");
			const { prompt } = lastExtraction(result.fake);
			assert.ok(
				prompt.includes("At most 1 questions"),
				`the extraction prompt did not state the configured cap:\n${prompt.slice(0, 600)}`,
			);
		},
	},
	{
		name: "more options than maxOptions is refused, and the prompt states the cap",
		config: { maxOptions: 2 },
		reply: CACHE_REPLY,
		extract: questionsJson(cacheQuestions()),
		answer() {
			throw new Error("an oversized questionnaire must not open a dialog");
		},
		check(result) {
			assertExtractionRefused(result, "At most 2 options are allowed per question");
			const { prompt } = lastExtraction(result.fake);
			assert.ok(
				prompt.includes("2-2 answer options"),
				`the extraction prompt did not state the configured range:\n${prompt.slice(0, 600)}`,
			);
		},
	},
	{
		name: "a long reply is cut to its last replyTailChars characters before extraction",
		config: { replyTailChars: 120 },
		// 300 characters the extractor must never see, then the question it must see.
		reply: LONG_REPLY,
		extract: questionsJson([
			{
				question: "Would you like tea?",
				header: "Tea",
				multiSelect: false,
				options: [
					{ label: "Yes", description: "A cup of tea" },
					{ label: "No", description: "Nothing for now" },
				],
			},
		]),
		answer(request) {
			requireMethod(request, "select", "one single-select question");
			return { value: request.options[0] };
		},
		check({ message, fake }) {
			const { seen } = lastExtraction(fake);
			assert.ok(seen.includes("Would you like tea?"), `the tail lost the question: ${JSON.stringify(seen)}`);
			assert.equal(seen, LONG_REPLY_TAIL, "the extractor must see exactly the tail window");
			assert.ok(seen.length < LONG_REPLY.length, "the whole reply reached the extractor");
			assertCompactEnvelope(message, { maxLines: 1 });
		},
	},
	{
		name: "an extraction that never answers times out and says so",
		config: { extractionTimeoutMs: 1_000 },
		reply: CACHE_REPLY,
		extract: () => ({ text: questionsJson(cacheQuestions()), delayMs: 10_000 }),
		answer() {
			throw new Error("a timed-out extraction must not open a dialog");
		},
		check(result) {
			assertExtractionRefused(result, "timed out after 1s");
		},
	},
	{
		name: "the extraction request carries only the reply tail, on the session model",
		reply: CACHE_REPLY,
		extract: questionsJson(cacheQuestions()),
		answer(request) {
			requireMethod(request, "select", "one single-select question");
			return { value: request.options[0] };
		},
		check({ message, fake }) {
			assertCompactEnvelope(message, { maxLines: 1 });
			const requests = fake.extractionRequests();
			assert.equal(requests.length, 1, "expected exactly one extraction request");
			const body = requests[0].body;
			// Prompt + one user turn: no assistant history, no earlier turns.
			assert.deepEqual(
				body.messages.map((message) => message.role),
				["system", "user"],
				"the extraction must not resend the conversation",
			);
			assert.ok(
				systemText(body).includes("You convert the questions"),
				`the extraction did not use the extraction prompt: ${systemText(body).slice(0, 300)}`,
			);
			assert.ok(
				lastUserText(body).includes("Which cache should we use?"),
				"the extraction did not receive the question it had to extract",
			);
		},
	},
];
