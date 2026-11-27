/**
 * Tests for the compact answer envelope (`src/format.ts`): numbered echo, per-question
 * degradation to full labels, header-as-key fallback, and omission of unanswered rows.
 *
 * Run via `npm test` (`node --test tests/`). Node 26 type-erases the imported `.ts`
 * files, so no build step is needed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { formatAnswersCompact, numberedOptions } from "../src/format.ts";

const REPLY = `Pick one of the following for caching:

1. No cache — always recompute
2. Memory cache with TTL
3. Disk cache across runs

Which features should be enabled?

1. Logging
2. Telemetry

How should we name the module?`;

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
		{
			question: "How should we name the module?",
			header: "Name",
			options: [
				{ label: "camelCase", description: "" },
				{ label: "snake_case", description: "" },
			],
		},
	],
};

const answer = (overrides) => ({
	questionIndex: 0,
	question: "",
	kind: "option",
	answer: null,
	...overrides,
});

test("numberedOptions maps every option when the reply numbered the list", () => {
	const [cache, features, name] = numberedOptions(REPLY, PARAMS);
	assert.deepEqual(cache, [1, 2, 3]);
	assert.deepEqual(features, [1, 2]);
	// camelCase / snake_case are not in the reply's numbered lists.
	assert.equal(name, undefined);
});

test("numberedOptions degrades per-question when a label is missing", () => {
	const reply = `Which storage?

1. In-memory — fast but volatile
2. SQLite on disk

Which storage?`;
	const params = {
		questions: [
			{
				question: "Which storage?",
				header: "Store",
				options: [
					{ label: "In-memory", description: "" },
					{ label: "SQLite on disk", description: "" },
					{ label: "Postgres", description: "" },
				],
			},
		],
	};
	assert.equal(numberedOptions(reply, params)[0], undefined);
});

test("numberedOptions returns undefined when the question text is absent", () => {
	assert.deepEqual(numberedOptions("", PARAMS), [undefined, undefined, undefined]);
});

test("full numbering path: option answers echo the reply's numbers", () => {
	const result = {
		cancelled: false,
		answers: [
			answer({ questionIndex: 0, kind: "option", answer: "Memory cache with TTL" }),
		],
	};
	// Unanswered questions emit no line at all.
	assert.equal(formatAnswersCompact(result, PARAMS, REPLY), "Cache → 2");
});

test("multi answers echo numbers and keep unmatched labels verbatim", () => {
	const result = {
		cancelled: false,
		answers: [
			answer({
				questionIndex: 1,
				kind: "multi",
				selected: ["Logging", "Telemetry"],
				answer: "only in dev",
			}),
		],
	};
	assert.equal(
		formatAnswersCompact(result, PARAMS, REPLY),
		"Features → 1, 2 | only in dev",
	);
});

test("multi with custom text only uses the colon form", () => {
	const result = {
		cancelled: false,
		answers: [
			answer({ questionIndex: 1, kind: "multi", selected: [], answer: "depends" }),
		],
	};
	const output = formatAnswersCompact(result, PARAMS, REPLY);
	assert.match(output, /Features: depends/);
});

test("custom answers never use numbering, even in a numbered reply", () => {
	const result = {
		cancelled: false,
		answers: [
			answer({ questionIndex: 2, kind: "custom", answer: "PascalCase" }),
		],
	};
	const output = formatAnswersCompact(result, PARAMS, REPLY);
	assert.match(output, /Name: PascalCase/);
	assert.doesNotMatch(output, /Name →/);
});

test("notes are inlined, global note goes on its own line", () => {
	const result = {
		cancelled: false,
		globalNote: "revisit next sprint",
		answers: [
			answer({ questionIndex: 0, kind: "option", answer: "No cache", notes: "keep it simple" }),
		],
	};
	const output = formatAnswersCompact(result, PARAMS, REPLY);
	assert.match(output, /Cache → 1 \| note: keep it simple/);
	assert.equal(output.split("\n").at(-1), "note: revisit next sprint");
});

test("keying follows questionIndex; unanswered rows are omitted entirely", () => {
	// Q2 was skipped: orderedAnswers() drops it, so answers[1] is question 3.
	const result = {
		cancelled: false,
		answers: [
			answer({ questionIndex: 0, kind: "option", answer: "No cache" }),
			answer({ questionIndex: 2, kind: "custom", answer: "PascalCase" }),
		],
	};
	const output = formatAnswersCompact(result, PARAMS, REPLY);
	assert.deepEqual(output.split("\n"), ["Cache → 1", "Name: PascalCase"]);
});

test("answers equal to the empty-input placeholder emit no line", () => {
	const result = {
		cancelled: false,
		answers: [answer({ questionIndex: 2, kind: "custom", answer: "" })],
	};
	assert.equal(formatAnswersCompact(result, PARAMS, REPLY), "");
});

test("duplicate headers fall back to Q{n}", () => {
	const params = {
		questions: [
			{ ...PARAMS.questions[0], header: "Cache" },
			{ ...PARAMS.questions[1], header: " Cache " }, // trim-equal duplicate
		],
	};
	const result = {
		cancelled: false,
		answers: [answer({ questionIndex: 0, kind: "option", answer: "No cache" })],
	};
	assert.equal(formatAnswersCompact(result, params, REPLY), "Q1 → 1");
});

test("a missing header renders without brackets", () => {
	const params = {
		questions: [
			{
				question: "Pick one of the following for caching:",
				header: "  ",
				options: [
					{ label: "No cache", description: "" },
					{ label: "Memory cache with TTL", description: "" },
					{ label: "Disk cache across runs", description: "" },
				],
			},
		],
	};
	const result = {
		cancelled: false,
		answers: [answer({ questionIndex: 0, kind: "option", answer: "No cache" })],
	};
	const output = formatAnswersCompact(result, params, REPLY);
	assert.match(output, /^Q1 → 1$/m);
});
