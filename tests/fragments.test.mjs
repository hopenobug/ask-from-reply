/**
 * Tests for the reply pre-processing the extractor relies on (`src/fragments.ts`): which
 * fragments of a reply the extraction model gets to see, and how the tail window cuts.
 *
 * The cases that matter are the shapes a reply uses to ask something without a literal
 * "?" — a line introducing a numbered list — and the shapes that only look like one
 * (prose that happens to end in a colon, a bullet list of remarks, decimals in a sentence).
 *
 * Run via `npm test` (`node --test tests/`). Node 26 type-erases the imported `.ts`
 * files, so no build step is needed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { focusQuestionFragments, replyTail } from "../src/fragments.ts";

test("a numbered list of next steps under a colon line is kept as one block", () => {
	const reply = `Here is what I would do:
1. Rename the module
2. Split the tests`;
	assert.equal(focusQuestionFragments(reply), reply);
});

test("a numbered list opens a block even with no colon on the line above", () => {
	const reply = `Some prose about the plan.
Next steps

1. Rename
2. Split`;
	// The introducing sentence is kept as the question; the blank line between them is not.
	assert.equal(
		focusQuestionFragments(reply),
		`Next steps
1. Rename
2. Split`,
	);
});

test("a numbered list that opens the reply becomes a block of its own", () => {
	const reply = `1. Rename the module
2. Split the tests`;
	assert.equal(focusQuestionFragments(reply), reply);
});

test("a colon line with no list below it does not open a block", () => {
	const reply = `Here is the plan:
Rename the module first.`;
	assert.equal(focusQuestionFragments(reply), reply);
});

test("a bullet list of remarks is not mistaken for a question", () => {
	const reply = `Notes:
- the build is slow
- the tests are flaky`;
	assert.equal(focusQuestionFragments(reply), reply);
});

test("a question-mark block still swallows the numbered list that follows it", () => {
	const reply = `Which cache?

1. None
2. Memory

Unrelated prose.`;
	assert.equal(
		focusQuestionFragments(reply),
		`Which cache?

1. None
2. Memory`,
	);
});

test("a numbered block stops at the prose that follows its list", () => {
	const reply = `Next steps:
1. Ship
2. Wait
Both are cheap.`;
	assert.equal(
		focusQuestionFragments(reply),
		`Next steps:
1. Ship
2. Wait`,
	);
});

test("numbers inside a sentence are not a numbered list", () => {
	// Two "digit + dot + space" runs used to read as a list written on one line, which
	// opened a block and swallowed the prose below it.
	const reply = `It costs 2. 5 dollars and 1. 9 euros.
- not an option
- also not`;
	assert.equal(focusQuestionFragments(reply), reply);
});

test("a reply with neither a question nor a list is passed through unchanged", () => {
	const reply = `Done.

I updated three files.`;
	assert.equal(focusQuestionFragments(reply), reply);
});

test("a list longer than the block cap is split, never dropping a line", () => {
	const reply = [
		"Next steps:",
		...Array.from({ length: 14 }, (_, i) => `${i + 1}. step ${i + 1}`),
	].join("\n");
	const fragments = focusQuestionFragments(reply);
	// The cap splits an over-long list into two blocks; it must not delete items: a dropped
	// line is a candidate option the extractor never sees.
	for (let i = 1; i <= 14; i += 1) {
		assert.ok(fragments.includes(`${i}. step ${i}`), `item ${i} was dropped: ${JSON.stringify(fragments)}`);
	}
	assert.ok(fragments.includes("Next steps:"), `the introducing line was dropped: ${JSON.stringify(fragments)}`);
});

test("a Chinese numbered list is a list, in every marker it is written with", () => {
	const reply = `下一步：
1、重命名模块
2、拆分测试`;
	assert.equal(focusQuestionFragments(reply), reply);
	// The CJK marker does not need a space after it, and the parenthesis forms count too.
	for (const marker of ["1.", "1)", "1、", "1．", "(1)", "（1）", "①"]) {
		const list = `下一步：\n${marker} 重命名\n${marker} 拆分`;
		assert.ok(
			focusQuestionFragments(list).includes("重命名"),
			`the ${JSON.stringify(marker)} list opened no block: ${JSON.stringify(focusQuestionFragments(list))}`,
		);
	}
});

test("a lettered list of next steps is a list too", () => {
	const reply = `Next steps:\na) Run the suite\nb) Split the extractor`;
	assert.equal(focusQuestionFragments(reply), reply);
});

test("a bullet list under a question is kept as its options", () => {
	// Bullets never open a block, but the question above them does — and the items are the
	// answers to pick from, so the block swallows them.
	const reply = `Which cache should we use?\n\n- no cache\n- memory cache`;
	assert.equal(focusQuestionFragments(reply), reply);
});

test("a bullet list with no question over it still opens nothing", () => {
	const reply = `Here is the plan:\n\n- rename the module\n- split the tests`;
	assert.equal(focusQuestionFragments(reply), reply);
});

test("a colon line that names a choice is a question, so its bullet list is options", () => {
	const reply = `用哪个缓存：\n- 不缓存\n- 内存缓存`;
	assert.equal(focusQuestionFragments(reply), reply);
	const english = `Which cache:\n- none\n- memory`;
	assert.equal(focusQuestionFragments(english), english);
});

test("a Chinese question needs no question mark", () => {
	// `吗` and `呢` end a question without one, and the list under it is its options.
	const reply = `我先改了提取器。\n\n要不要顺手把测试也拆了\n1. 拆\n2. 不拆`;
	assert.equal(focusQuestionFragments(reply), `要不要顺手把测试也拆了\n1. 拆\n2. 不拆`);
	assert.equal(focusQuestionFragments("还有别的呢"), "还有别的呢");
});

test("a yes/no opening is a question, a statement about it is not", () => {
	// `要不要…` opens the question; the full stop at the end would make it a statement.
	const reply = `要不要我把测试也拆了\n\n这是下一步。`;
	assert.equal(focusQuestionFragments(reply), "要不要我把测试也拆了");
	const statement = `是否要拆由你决定。\n\nUnrelated prose.`;
	assert.equal(focusQuestionFragments(statement), statement);
});

test("replyTail keeps the last characters, counted in code points", () => {
	assert.equal(replyTail("abcdef", 3), "def");
	// An emoji is two UTF-16 units but one code point: slicing by units would cut a
	// surrogate pair in half, so `Array.from` is what makes the count honest.
	assert.equal(replyTail("👍👍👍", 2), "👍👍");
	assert.equal(replyTail("short", 99), "short");
});
