/**
 * Tests for the shape guard that sits between the extractor model's JSON and the question
 * normalizer/validator (`src/question-shape.ts`).
 *
 * Every case here used to be either a crash (`Cannot read properties of undefined (reading
 * 'map')`) or a wrong verdict ("The last reply asks no questions" for a reply that did carry
 * a `questions` key). The suite pins the wording because it is what the user reads in the
 * `Could not extract questions: …` notification.
 *
 * Run via `npm test` (`node --test tests/`). Node 26 type-erases the imported `.ts` files,
 * so no build step is needed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { checkQuestionShape } from "../src/question-shape.ts";

const ONE_QUESTION = {
	questions: [
		{
			question: "Which cache should we use?",
			header: "Cache",
			multiSelect: false,
			options: [
				{ label: "No cache", description: "Always recompute" },
				{ label: "Memory", description: "With a TTL" },
			],
		},
	],
};

/** The reason of a rejected shape; fails loudly when the shape was accepted. */
function reasonFor(value) {
	const result = checkQuestionShape(value);
	assert.equal(result.ok, false, `expected a rejection, got ${JSON.stringify(result)}`);
	return result.reason;
}

test("a well-formed extraction is accepted verbatim", () => {
	const result = checkQuestionShape(ONE_QUESTION);
	assert.deepEqual(result, { ok: true, params: ONE_QUESTION });
});

test("an empty question list is accepted; emptiness is the caller's call", () => {
	assert.deepEqual(checkQuestionShape({ questions: [] }), { ok: true, params: { questions: [] } });
});

test("unknown keys are dropped at every level", () => {
	const result = checkQuestionShape({
		extra: "ignored",
		questions: [
			{
				...ONE_QUESTION.questions[0],
				confidence: 0.9,
				options: ONE_QUESTION.questions[0].options.map((option) => ({ ...option, weight: 3 })),
			},
		],
	});
	assert.deepEqual(result, { ok: true, params: ONE_QUESTION });
});

test("an optional preview survives, and only when it is text", () => {
	const withPreview = {
		questions: [
			{
				...ONE_QUESTION.questions[0],
				options: [{ label: "No cache", description: "Always recompute", preview: "# mockup" }],
			},
		],
	};
	assert.deepEqual(checkQuestionShape(withPreview), { ok: true, params: withPreview });
	assert.equal(
		reasonFor({ questions: [{ ...withPreview.questions[0], options: [{ label: "A", description: "", preview: 42 }] }] }),
		'option 1 of question 1 has a "preview" that is not text',
	);
});

test("a description may be empty but a label may not", () => {
	const result = checkQuestionShape({
		questions: [{ question: "Q?", header: "Q", options: [{ label: "A", description: "" }] }],
	});
	assert.equal(result.ok, true);
	assert.equal(
		reasonFor({ questions: [{ question: "Q?", header: "Q", options: [{ label: "  ", description: "" }] }] }),
		"option 1 of question 1 has no label",
	);
});

test("multiSelect must be a boolean when present, and may be absent", () => {
	const withoutFlag = { questions: [{ question: "Q?", header: "Q", options: [{ label: "A", description: "" }] }] };
	assert.equal(checkQuestionShape(withoutFlag).ok, true);
	assert.equal(reasonFor({ questions: [{ ...withoutFlag.questions[0], multiSelect: "true" }] }), 'question 1 has a "multiSelect" that is not true or false');
});

test("JSON that is not an object is refused", () => {
	for (const value of [[], "questions", 42, null, undefined]) {
		assert.equal(reasonFor(value), "the model returned JSON that is not an object");
	}
});

test("a missing or non-array questions key is its own failure, never 'no questions'", () => {
	for (const value of [{}, { questions: "none today" }, { questions: { 0: ONE_QUESTION.questions[0] } }]) {
		assert.equal(reasonFor(value), 'the model returned no "questions" list');
	}
});

test("each question must be an object", () => {
	assert.equal(reasonFor({ questions: [null] }), "question 1 is not an object");
	assert.equal(reasonFor({ questions: [[]] }), "question 1 is not an object");
	assert.equal(reasonFor({ questions: [ONE_QUESTION.questions[0], "second"] }), "question 2 is not an object");
});

test("question text is required", () => {
	assert.equal(reasonFor({ questions: [{ header: "Cache", options: [] }] }), "question 1 has no text");
	assert.equal(reasonFor({ questions: [{ question: 42, header: "Cache", options: [] }] }), "question 1 has no text");
	assert.equal(reasonFor({ questions: [{ question: "   ", header: "Cache", options: [] }] }), "question 1 has no text");
});

test("a header is required", () => {
	assert.equal(reasonFor({ questions: [{ question: "Q?", options: [] }] }), "question 1 has no header");
	assert.equal(reasonFor({ questions: [{ question: "Q?", header: " ", options: [] }] }), "question 1 has no header");
});

test("a question without options is refused with a readable reason", () => {
	// The original bug: `q.options` was undefined and `.map` threw.
	assert.equal(
		reasonFor({ questions: [{ question: "Which cache?", header: "Cache" }] }),
		'question 1 has no "options" list',
	);
	assert.equal(
		reasonFor({ questions: [{ question: "Which cache?", header: "Cache", options: "1, 2" }] }),
		'question 1 has no "options" list',
	);
});

test("each option must be an object with a label and a description", () => {
	const question = { question: "Q?", header: "Q" };
	assert.equal(reasonFor({ questions: [{ ...question, options: [null] }] }), "option 1 of question 1 is not an object");
	assert.equal(
		reasonFor({ questions: [{ ...question, options: [{ description: "d" }] }] }),
		"option 1 of question 1 has no label",
	);
	assert.equal(
		reasonFor({ questions: [{ ...question, options: [{ label: "A" }] }] }),
		"option 1 of question 1 has no description",
	);
	assert.equal(
		reasonFor({ questions: [{ ...question, options: [{ label: "A", description: null }] }] }),
		"option 1 of question 1 has no description",
	);
});

test("the reported position follows the offending question and option", () => {
	const good = ONE_QUESTION.questions[0];
	const broken = { question: "Second?", header: "Two", options: [{ label: "A" }] };
	assert.equal(
		reasonFor({ questions: [good, broken] }),
		"option 1 of question 2 has no description",
	);
	assert.equal(
		reasonFor({ questions: [good, { ...broken, options: [{ label: "A", description: "" }, "x"] }] }),
		"option 2 of question 2 is not an object",
	);
});
