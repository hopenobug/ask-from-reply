/**
 * The Submit tab previews the exact text the answers will be sent as, below the
 * per-answer summary: the summary answers "what did I pick", the preview answers
 * "what will the model read".
 *
 * The preview is rendered from `formatAnswersCompact` — the same call that builds the
 * message — through `sentTextLines`. This pins that contract without a terminal; the
 * visibility of the block itself is covered by `npm run e2e:tui`.
 *
 * Run via `npm test` (`node --test tests/`).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { formatAnswersCompact } from "../src/format.ts";
import { sentTextLines } from "../src/vendor/view/sent-text-block.ts";

const REPLY = `Pick one of the following for caching:

1. No cache — always recompute
2. Memory cache with TTL
3. Disk cache across runs

Which features should be enabled?

1. Logging
2. Telemetry`;

const PARAMS = {
	questions: [
		{
			question: "Pick one of the following for caching:",
			header: "Cache",
			options: [
				{ label: "No cache", description: "" },
				{ label: "Memory cache with TTL", description: "" },
				{ label: "Disk cache across runs", description: "" },
			],
		},
		{
			question: "Which features should be enabled?",
			header: "Features",
			multiSelect: true,
			options: [
				{ label: "Logging", description: "" },
				{ label: "Telemetry", description: "" },
			],
		},
	],
};

const result = {
	answers: [
		{
			questionIndex: 0,
			question: "",
			kind: "option",
			answer: "Memory cache with TTL",
			notes: "needs TTL",
		},
		{ questionIndex: 1, question: "", kind: "multi", answer: null, selected: ["Logging", "Telemetry"] },
	],
	cancelled: false,
	globalNote: "prefer disk",
};

test("preview rows are the envelope's own lines, in order and unreworded", () => {
	const sent = formatAnswersCompact(result, PARAMS, REPLY);
	const rows = sentTextLines(sent);

	assert.deepEqual(rows, sent.split("\n"));
	assert.deepEqual(rows, ["Cache → 2 | note: needs TTL", "Features → 1, 2", "note: prefer disk"]);
});

test("free-text answers preview in the colon form, never numbered", () => {
	const custom = {
		answers: [{ questionIndex: 0, question: "", kind: "custom", answer: "camelCase please" }],
		cancelled: false,
	};
	const params = {
		questions: [{ question: "Name?", header: "Name", options: [{ label: "camelCase", description: "" }] }],
	};
	const rows = sentTextLines(formatAnswersCompact(custom, params, "How should we name the module?"));
	assert.deepEqual(rows, ["Name: camelCase please"]);
});

test("an empty envelope renders no preview rows", () => {
	const empty = { answers: [], cancelled: false };
	assert.deepEqual(sentTextLines(formatAnswersCompact(empty, PARAMS, REPLY)), []);
	assert.deepEqual(sentTextLines(""), []);
	assert.deepEqual(sentTextLines("\n\n"), []);
});

test("one row per answer, even when a note carries its own newline", () => {
	const multiline = {
		answers: [
			{ questionIndex: 0, question: "", kind: "option", answer: "No cache", notes: "line one\nline two" },
		],
		cancelled: false,
	};
	const rows = sentTextLines(formatAnswersCompact(multiline, PARAMS, REPLY));
	assert.deepEqual(rows, ["Cache → 1 | note: line one", "line two"]);
});
