/**
 * A local OpenAI-compatible provider so e2e runs never touch a real model.
 *
 * pi's provider layer talks HTTP, so a canned server is enough: each scenario says what the
 * model answers, and the extension under test cannot tell the difference. That removes the
 * two things that made these tests flaky — model latency and model whim — and it makes the
 * failure paths testable at all (malformed JSON, oversized answers, a request that never
 * comes back).
 *
 * The stack is: this server (SSE) ← pi's openai-completions provider ← the extension. The
 * provider is registered by `fake-provider.ts`, a second `-e` only the e2e runs pass, so
 * the real `~/.pi/agent/models.json` and settings are never involved.
 */
import { createServer } from "node:http";

export const FAKE_PROVIDER = "fake";
export const FAKE_MODEL = "fake-mini";
/** Env var read by `fake-provider.ts`, the extension that points pi at this server. */
export const FAKE_BASE_URL_ENV = "AFR_FAKE_BASE_URL";
/** CLI args that select the fake model (`provider/model` form needs no `--provider`). */
export const FAKE_MODEL_ARGS = ["--model", `${FAKE_PROVIDER}/${FAKE_MODEL}`];
/** First line of the extraction system prompt (`src/extract.ts`); identifies its requests. */
const EXTRACTION_MARKER = "You convert the questions";

/**
 * The two requests a run makes: the main line answering the user, and the side request that
 * turns the answer into a questionnaire. Scenarios answer each differently.
 */
export function requestKind(body) {
	return systemText(body).includes(EXTRACTION_MARKER) ? "extraction" : "main";
}

export function systemText(body) {
	const messages = Array.isArray(body?.messages) ? body.messages : [];
	for (const message of messages) {
		if (message?.role === "system") return textOf(message.content);
	}
	return "";
}

/** The last user message — for extraction that is the (possibly truncated) reply tail. */
export function lastUserText(body) {
	const messages = Array.isArray(body?.messages) ? body.messages : [];
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "user") return textOf(messages[i].content);
	}
	return "";
}

function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

/**
 * Serve one scenario's answers.
 *
 * `respond({ kind, body, index })` returns:
 * - `{ text }` — stream that text back as the answer;
 * - `{ text, delayMs }` — wait first, so a timeout can be provoked;
 * - `{ status, text }` — fail the request (a 500 exercises the provider error path).
 *
 * `index` counts every request of that kind, so one scenario can answer the same kind
 * differently on the second call.
 */
export async function startFakeModel({ respond }) {
	const requests = [];
	const counters = { extraction: 0, main: 0 };
	const server = createServer((request, response) => {
		collect(request)
			.then(async (body) => {
				const kind = requestKind(body);
				const index = counters[kind]++;
				requests.push({ kind, index, body });
				const reply = await respond({ kind, index, body });
				if (reply?.status && reply.status >= 400) {
					response.writeHead(reply.status, { "content-type": "application/json" });
					response.end(JSON.stringify({ error: { message: reply.text ?? "fake failure" } }));
					return;
				}
				if (reply?.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
				writeStream(response, reply?.text ?? "");
			})
			.catch((error) => {
				response.writeHead(500, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: { message: String(error) } }));
			});
	});
	// The extension aborts in-flight extraction on timeout; a dropped socket must not take
	// the server (and with it the rest of the test) down.
	server.on("clientError", (_error, socket) => socket.destroy());
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const port = server.address().port;
	const baseUrl = `http://127.0.0.1:${port}/v1`;

	return {
		port,
		baseUrl,
		requests,
		/** Env overlay `fake-provider.ts` reads to register this server as a provider. */
		env: { [FAKE_BASE_URL_ENV]: baseUrl },
		args: FAKE_MODEL_ARGS,
		extractionRequests: () => requests.filter((entry) => entry.kind === "extraction"),
		mainRequests: () => requests.filter((entry) => entry.kind === "main"),
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections?.();
				server.close(() => resolve());
			}),
	};
}

async function collect(request) {
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	const raw = Buffer.concat(chunks).toString("utf8");
	if (raw.length === 0) return {};
	try {
		return JSON.parse(raw);
	} catch {
		return {};
	}
}

/**
 * One chat-completion worth of SSE. The provider streams, so this is the only shape it
 * accepts: content deltas, a stop chunk, a usage chunk, then the `[DONE]` sentinel.
 */
function writeStream(response, text) {
	response.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
	const id = "chatcmpl-fake";
	const chunk = (payload) => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: FAKE_MODEL, ...payload })}\n\n`;
	response.write(chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }));
	if (text.length > 0) {
		response.write(chunk({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }));
	}
	response.write(chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
	const tokens = Math.max(1, Math.ceil(text.length / 4));
	response.write(
		chunk({ choices: [], usage: { prompt_tokens: tokens, completion_tokens: tokens, total_tokens: tokens * 2 } }),
	);
	response.end("data: [DONE]\n\n");
}
