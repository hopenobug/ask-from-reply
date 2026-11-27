/**
 * Real-terminal smoke tests: `npm run e2e:tui`.
 *
 * Each test starts the actual pi TUI under herdr-core (`hc`), presses the extension
 * shortcut and types into the dialog with real keystrokes. The RPC suite (`npm run e2e`)
 * covers the dialog variations; these only prove what cannot be proven headlessly: the TUI
 * mount, the keystroke routing, the Submit tab's two preview views and the hand-back.
 *
 * The model is fake here too (`fake-model.mjs` + `fake-provider.ts`), so both the reply and
 * the extracted questionnaire are scripted. Skips when `hc` or `bash` is missing. Terminals
 * are always killed and removed, and their empty working directories deleted.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { CONFIG_ENV, CONFIG_FILE } from "../../src/config.ts";
import { FAKE_PROVIDER_EXT, EXT_DIR, poll, resolvePiCli, sleep, withEmptyWorkspace } from "./harness.mjs";
import { FAKE_MODEL_ARGS, startFakeModel } from "./fake-model.mjs";
import { CACHE_REPLY, cacheQuestions, parseAnswerLine, questionsJson } from "./scenarios.mjs";

const run = promisify(execFile);

/** A second question, so the Submit tab has more than one answer to preview. */
const TWO_QUESTIONS = questionsJson([
	...cacheQuestions(),
	{
		question: "Which features should we enable?",
		header: "Features",
		multiSelect: false,
		options: [
			{ label: "Logging", description: "Write to the log file" },
			{ label: "Telemetry", description: "Send usage counters" },
			{ label: "Metrics", description: "Expose a metrics endpoint" },
		],
	},
]);

/** The prompt only has to reach the model; the fake one answers with `CACHE_REPLY`. */
const PRIME_PROMPT = "Which cache should we use for the index?";

const SENT_HEADING = "Text sent to the model:";
const SUMMARY_ROW = /^\s*●\s*Cache\s*$/m;

/**
 * How often the terminal is re-read while waiting for a keystroke to land. Each read is an
 * `hc` round trip, so this is the trade between responsiveness and process churn.
 */
const POLL_INTERVAL = 500;
/** How many terminals run at once: `concurrency` on the parent test, as in the RPC suite. */
const CONCURRENCY = Math.max(1, Number(process.env.AFR_E2E_TUI_CONCURRENCY ?? 3) || 3);

async function hc(args, { timeout = 60_000 } = {}) {
	try {
		const { stdout, stderr } = await run("hc", args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
		return { ok: true, stdout, stderr };
	} catch (error) {
		return { ok: false, stdout: error.stdout ?? "", stderr: error.stderr ?? String(error) };
	}
}

async function hasHc() {
	const probe = await hc(["--version"], { timeout: 20_000 });
	return probe.ok || probe.stdout.length > 0;
}

async function hasBash() {
	try {
		await run("bash", ["-c", "true"], { timeout: 20_000, windowsHide: true });
		return true;
	} catch {
		return false;
	}
}

/** Single-quote a value for a POSIX shell. */
function q(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** The terminal's turn counter; a submit must not move it. */
async function turnOf(terminal) {
	const listed = await hc(["ls"]);
	if (!listed.ok) return undefined;
	try {
		const data = JSON.parse(listed.stdout);
		return data.terminals?.find((entry) => entry.address === terminal)?.turn;
	} catch {
		return undefined;
	}
}

/** Everything the terminal shows, history included once the turn has settled. */
async function screen(terminal) {
	const read = await hc(["read", "--lines", "300", terminal]);
	return read.stdout;
}

/**
 * Boot a background pi with the extension and the fake provider loaded, run `body`, then
 * always tear it down.
 *
 * `hc run` has no environment option, so the variables a scenario needs are exported inside
 * a `bash -c` wrapper that then `exec`s pi — one process, so the terminal the `hc` address
 * points at is pi itself. The inherited `PI_PROVIDER` / `PI_MODEL` of whatever session
 * started the test are unset there, or they would out-rank the fake model.
 */
async function withTerminal(t, body, { config, extraction = questionsJson(cacheQuestions()) } = {}) {
	if (!(await hasHc())) {
		t.skip("herdr-core (`hc`) is not installed");
		return;
	}
	if (!(await hasBash())) {
		t.skip("pointing `hc run` at the fake provider needs bash");
		return;
	}
	const fake = await startFakeModel({
		respond: ({ kind }) => ({ text: kind === "extraction" ? extraction : CACHE_REPLY }),
	});
	let settingsDir;
	try {
		await withEmptyWorkspace(async (cwd) => {
			const launcher = resolvePiCli();
			const argv = [
				launcher.command,
				...launcher.args,
				"-e",
				EXT_DIR,
				"-e",
				FAKE_PROVIDER_EXT,
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-context-files",
				"--approve",
				...FAKE_MODEL_ARGS,
			];
			const exports = [
				"unset PI_PROVIDER PI_MODEL",
				`export AFR_FAKE_BASE_URL=${q(fake.baseUrl)}`,
				// Default the settings file to a path inside the throwaway workspace that does not
				// exist, so the real agent-dir config never leaks into a test; an explicit config
				// below re-exports the key and wins.
				`export ${CONFIG_ENV}=${q(join(cwd, CONFIG_FILE))}`,
			];
			if (config !== undefined) {
				settingsDir = mkdtempSync(join(tmpdir(), "afr-cfg-"));
				writeFileSync(join(settingsDir, CONFIG_FILE), JSON.stringify(config));
				exports.push(`export ${CONFIG_ENV}=${q(join(settingsDir, CONFIG_FILE))}`);
			}
			const started = await hc(
				[
					"run",
					"--bg",
					"--no-notify",
					"--name",
					`afr-e2e-${Math.random().toString(36).slice(2, 8)}`,
					"--cwd",
					cwd,
					"bash",
					"-c",
					`${exports.join("; ")}; exec ${argv.map(q).join(" ")}`,
				],
				{ timeout: 120_000 },
			);
			assert.ok(started.ok, `hc run failed: ${started.stderr || started.stdout}`);
			const terminal = JSON.parse(started.stdout.trim().split("\n").pop()).address;
			try {
				// Ready: the startup banner replaced the empty screen.
				await poll(async () => (await screen(terminal)).includes("ctrl+c/ctrl+d"), {
					timeout: 90_000,
					interval: POLL_INTERVAL,
					label: "the pi TUI to finish starting",
				});
				await body(terminal, fake);
			} finally {
				await hc(["interrupt", terminal], { timeout: 30_000 });
				await sleep(500);
				await hc(["kill", terminal], { timeout: 30_000 });
				await hc(["rm", terminal], { timeout: 30_000 });
			}
		});
	} finally {
		if (settingsDir) rmSync(settingsDir, { recursive: true, force: true });
		await fake.close();
	}
}

/** Wait out the scripted turn, then open the questionnaire on it. */
async function askAndOpen(terminal) {
	await hc(["send", terminal, PRIME_PROMPT], { timeout: 120_000 });
	await hc(["wait", terminal, "--timeout", "180"], { timeout: 200_000 });
	await hc(["keys", terminal, "ctrl+shift+a"]);
	await poll(async () => /Enter to select/.test(await screen(terminal)), {
		timeout: 90_000,
		interval: POLL_INTERVAL,
		label: "the questionnaire dialog to open",
	});
}

function answerLines(text) {
	return text
		.split("\n")
		.map((line) => line.trim())
		.map((line) => parseAnswerLine(line))
		.filter((line) => line !== null);
}

/**
 * The transcript is prose, so only a `Key → 2` line (a bare number list after the
 * marker the formatter picks for numbered choices) counts as the hand-back.
 */
function numericAnswerLines(text) {
	return answerLines(text).filter((line) => line.marker === "→" && /^\d+(, \d+)*$/.test(line.value));
}

/** Question tabs in the tab bar (`←  □ Cache  □ Features  ✓ Submit  →`). */
function questionTabCount(text) {
	const bar = text.split("\n").find((line) => line.includes("←") && line.includes("Submit"));
	if (!bar) return 0;
	return (bar.slice(bar.indexOf("←"), bar.indexOf("Submit")).match(/[□■]/g) ?? []).length;
}

/** The sent-text preview block: rows between its heading and the footer rule. */
function previewRows(text) {
	const lines = text.split("\n").map((line) => line.replace(/\s+$/, ""));
	const heading = lines.findIndex((line) => line.includes(SENT_HEADING));
	if (heading === -1) return [];
	const rows = [];
	for (const line of lines.slice(heading + 1)) {
		if (line.includes("────") || (line.trim().length === 0 && rows.length > 0)) break;
		if (line.trim().length > 0) rows.push(line.trim());
	}
	return rows;
}

/** Walk the tab bar to the Submit tab (digit answers auto-advance, so this is at most a few). */
async function openSubmitTab(terminal) {
	for (let i = 0; i < 4; i += 1) {
		const text = await screen(terminal);
		if (SUMMARY_ROW.test(text) || text.includes(SENT_HEADING)) return text;
		await hc(["keys", terminal, "tab"]);
		await sleep(POLL_INTERVAL);
	}
	return screen(terminal);
}

/** A digit answers the only question, and the form submits itself. */
async function digitAnswerCase(t) {
	await withTerminal(t, async (terminal) => {
		await askAndOpen(terminal);

		// Digit 2 answers the 2nd option; a single-question form submits right away.
		await hc(["keys", terminal, "2"]);
		const seen = await poll(
			async () => {
				const lines = numericAnswerLines(await screen(terminal));
				return lines.length > 0 ? lines : false;
			},
			{ timeout: 90_000, interval: POLL_INTERVAL, label: "the answer line to reach the transcript" },
		);

		assert.equal(seen.length, 1, `expected one answer line, got ${JSON.stringify(seen)}`);
		const [answer] = seen;
		assert.ok(answer.key.length > 0, `the answer line lost its key: ${answer.line}`);
		assert.equal(answer.value, "2", `the 2nd option should echo as "→ 2": ${answer.line}`);
	});
}

/**
 * The Submit tab shows one view at a time: `p` flips between the answer summary and the
 * literal text that will be sent, and submitting sends what was previewed.
 */
async function previewToggleCase(t) {
	await withTerminal(
		t,
		async (terminal) => {
			await askAndOpen(terminal);
			const tabs = questionTabCount(await screen(terminal));
			assert.equal(tabs, 2, `expected two question tabs, got ${tabs}`);

			// Answer the first question, then walk to Submit (digit answers auto-advance).
			await hc(["keys", terminal, "1"]);
			await sleep(POLL_INTERVAL);
			const submit = await openSubmitTab(terminal);
			assert.match(submit, SUMMARY_ROW, `the Submit tab did not open on the answer summary:\n${submit.slice(-1500)}`);
			assert.ok(!submit.includes(SENT_HEADING), "both previews were visible at once");

			// `p` -> the literal text that will be sent, and nothing else.
			await hc(["keys", terminal, "p"]);
			const rows = await poll(
				async () => {
					const found = previewRows(await screen(terminal));
					return found.length > 0 ? found : false;
				},
				{ timeout: 30_000, interval: POLL_INTERVAL, label: "`p` rendering the sent text" },
			);
			for (const row of rows) {
				assert.ok(
					parseAnswerLine(row) !== null || /^note: /.test(row),
					`a preview row is not an answer line: ${JSON.stringify(row)}`,
				);
			}
			// Only the first question was answered, so exactly that answer has to show up.
			assert.equal(rows.length, 1, `the preview dropped answers, got ${JSON.stringify(rows)}`);
			const previewed = parseAnswerLine(rows[0]);
			assert.ok(previewed !== null, `the preview row is not an answer line: ${JSON.stringify(rows[0])}`);
			assert.equal(previewed.key, "Cache", `the preview lost the answer's key: ${JSON.stringify(rows[0])}`);
			assert.equal(previewed.value, "1", `the preview lost the answer's value: ${JSON.stringify(rows[0])}`);
			const flipped = await screen(terminal);
			assert.ok(!SUMMARY_ROW.test(flipped), "the answer summary was still visible next to the sent text");
			assert.match(flipped, /p to see the answers/, "the hint did not offer the way back");

			// `p` again -> back to the summary, same single view rule.
			await hc(["keys", terminal, "p"]);
			const back = await poll(
				async () => {
					const text = await screen(terminal);
					return SUMMARY_ROW.test(text) ? text : false;
				},
				{ timeout: 30_000, interval: POLL_INTERVAL, label: "`p` going back to the summary" },
			);
			assert.ok(!back.includes(SENT_HEADING), "the sent text stayed visible after flipping back");
			assert.match(back, /p to see the message/, "the hint did not offer the way forward");

			// Submitting sends exactly those rows: interrupt the follow-up turn, then read history.
			// The turn counter is the "it was really sent" signal, so there is nothing to sleep for.
			await hc(["keys", terminal, "p"]);
			await sleep(POLL_INTERVAL);
			const turnsBefore = await turnOf(terminal);
			await hc(["keys", terminal, "enter"]);
			await poll(async () => ((await turnOf(terminal)) ?? 0) > (turnsBefore ?? 0), {
				timeout: 30_000,
				interval: POLL_INTERVAL,
				label: "the submit turn to start",
			});
			await hc(["interrupt", terminal], { timeout: 30_000 });
			const history = await poll(
				async () => {
					const text = await screen(terminal);
					return rows.every((row) => text.includes(row)) ? text : false;
				},
				{ timeout: 60_000, interval: POLL_INTERVAL, label: "the sent text to land in the transcript" },
			);
			assert.ok(!history.includes("Answers ("), "the legacy verbose envelope was sent");
			assert.ok(!history.includes("(no input)"), "the empty-input placeholder was sent");
		},
		{ extraction: TWO_QUESTIONS },
	);
}

/** `submit: "editor"` (TUI only): the answers are parked in the input box, not sent. */
async function editorParkCase(t) {
	await withTerminal(
		t,
		async (terminal) => {
			await askAndOpen(terminal);
			const turnsBefore = await turnOf(terminal);

			await hc(["keys", terminal, "2"]);
			const parked = await poll(
				async () => {
					// The answer line from the transcript never contains "→"; only the editor row does.
					const text = await screen(terminal);
					const line = text
						.split("\n")
						.map((row) => row.trim())
						.find((row) => /→ 2$/.test(row));
					return line ?? false;
				},
				{ timeout: 60_000, interval: POLL_INTERVAL, label: "the answers to appear in the input box" },
			);
			assert.ok(parked.length > 0, "the input box stayed empty");

			// Nothing was sent: a send would have started a turn. Asserting an absence needs a
			// quiet period, so this is the one fixed wait in the suite.
			await sleep(2_500);
			const turnsAfter = await turnOf(terminal);
			assert.equal(
				turnsAfter,
				turnsBefore,
				`the answers were sent instead of parked (turn ${turnsBefore} -> ${turnsAfter})`,
			);

			// And pressing enter delivers that very text.
			await hc(["keys", terminal, "enter"]);
			await hc(["wait", terminal, "--timeout", "180"], { timeout: 200_000 });
			const delivered = await poll(
				async () => {
					const text = await screen(terminal);
					return text.includes("→ 2") ? text : false;
				},
				{ timeout: 60_000, interval: POLL_INTERVAL, label: "the parked text to be sent by hand" },
			);
			assert.equal(
				await turnOf(terminal),
				(turnsBefore ?? 0) + 1,
				`pressing enter should start exactly one turn:\n${delivered.slice(-2000)}`,
			);
		},
		{ config: { submit: "editor" } },
	);
}

const CASES = [
	{ name: "one question: a digit answer reaches the transcript", body: digitAnswerCase },
	{ name: "Submit shows one preview at a time and `p` flips it", body: previewToggleCase },
	{ name: 'config submit "editor" parks the answers instead of sending', body: editorParkCase },
];

test("ask-from-reply e2e in a real terminal", { concurrency: CONCURRENCY, timeout: 900_000 }, async (t) => {
	await Promise.all(CASES.map(({ name, body }) => t.test(name, { timeout: 420_000 }, body)));
});
