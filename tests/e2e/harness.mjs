/**
 * E2E harness: spawn a real `pi --mode rpc`, drive it over the JSONL protocol, and give
 * every scenario its own throwaway empty working directory.
 *
 * Why a hand-written client instead of pi's `RpcClient`: `send()` is private there and it
 * only re-emits `extension_ui_request` without replying, so a test could never answer the
 * questionnaire. The protocol surface used here is small:
 *
 *   commands  prompt, get_messages, abort
 *   events    extension_ui_request, agent_settled, message_* …
 *   replies   { type: "extension_ui_response", id, value | confirmed | cancelled }
 *
 * The pi CLI is spawned directly (same resolution as `bin/pi-launcher.js`, minus its
 * blocking `spawnSync` wrapper — killing that wrapper would orphan the real pi process).
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { CONFIG_ENV, CONFIG_FILE } from "../../src/config.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** This extension's package root, passed to pi as an explicit `-e` extension path. */
export const EXT_DIR = resolve(HERE, "../..");
/**
 * The fake provider, also loaded with `-e`. It is the only way to point pi at a model
 * nobody has to pay for or wait for: the CLI can pick a model but cannot declare one, and
 * a `models.json` copy would cost a throwaway `PI_CODING_AGENT_DIR` that pi then installs
 * packages into.
 */
export const FAKE_PROVIDER_EXT = join(HERE, "fake-provider.ts");
const AGENT_DIR = join(homedir(), ".pi", "agent");

/** Isolation flags: nothing from the user's settings, sessions, skills or AGENTS.md. */
export const ISOLATION_ARGS = [
	"--no-session",
	"--no-extensions",
	"--no-skills",
	"--no-context-files",
	"--approve",
];

/**
 * `--no-extensions` only disables discovery; the explicit `-e` paths still load, and only
 * the ones passed here. Two of them: the extension under test, and the fake provider.
 */
export function extensionArgs(extra = []) {
	return [...ISOLATION_ARGS, "-e", EXT_DIR, "-e", FAKE_PROVIDER_EXT, ...extra];
}

/** Inherited pi overrides that would out-rank what a scenario asks for. */
const INHERITED_PI_KEYS = [
	"PI_PROVIDER",
	"PI_MODEL",
	"PI_REASONING_LEVEL",
	"PI_SESSION_FILE",
	"PI_SESSION_ID",
	"PI_CODING_AGENT_DIR",
];

/**
 * Environment for a child pi.
 *
 * The suite itself usually runs from inside a pi session, so `process.env` carries that
 * session's `PI_PROVIDER` / `PI_MODEL` (which would out-rank the fake provider), a
 * `PI_SESSION_FILE` pointing at the wrong session, and a proxy that would swallow calls to
 * the loopback fake provider. All of that is dropped; `overrides` then says what the
 * scenario wants.
 */
export function childEnv(overrides = {}) {
	const env = { ...process.env };
	for (const key of INHERITED_PI_KEYS) delete env[key];
	return { ...env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", ...overrides };
}

/**
 * Resolve the pi CLI bundle to run with `process.execPath`.
 *
 * `PI_CLI` overrides it (absolute path to the CLI entry, e.g. `dist/bundle/cli.js`).
 * Falls back to `pi` on PATH when no managed install is found.
 */
export function resolvePiCli() {
	if (process.env.PI_CLI) {
		return { command: process.execPath, args: [process.env.PI_CLI], env: {}, shell: false };
	}
	const installRoot = join(AGENT_DIR, "install");
	const versionFile = join(installRoot, "current-version");
	if (existsSync(versionFile)) {
		const version = readFileSync(versionFile, "utf8").trim();
		const packageDir = join(installRoot, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent");
		const packageJsonPath = join(packageDir, "package.json");
		if (existsSync(packageJsonPath)) {
			const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
			const bin = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.pi;
			const cli = bin ? resolve(packageDir, bin) : undefined;
			if (cli && existsSync(cli)) {
				return {
					command: process.execPath,
					args: [cli],
					env: { PI_MANAGED_INSTALL_ROOT: installRoot },
					shell: false,
				};
			}
		}
	}
	return { command: "pi", args: [], env: {}, shell: true };
}

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Poll `fn` until it returns something truthy; throw a labelled error on timeout. */
export async function poll(fn, { timeout = 60_000, interval = 100, label = "condition" } = {}) {
	const deadline = Date.now() + timeout;
	for (;;) {
		const value = await fn();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`Timed out after ${timeout}ms waiting for ${label}`);
		await sleep(interval);
	}
}

/** Concatenated text of an AgentMessage's content (string or block array). */
export function messageText(message) {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

/** A JSONL client for one `pi --mode rpc` process. */
export class RpcSession {
	/**
	 * @param {{
	 *   cwd: string,
	 *   launcher?: ReturnType<typeof resolvePiCli>,
	 *   env?: Record<string, string>,
	 *   args?: string[],
	 * }} options
	 */
	constructor({ cwd, launcher = resolvePiCli(), env = {}, args = [] }) {
		this.cwd = cwd;
		this.launcher = launcher;
		/** Extra environment for the child process (e.g. an `ASK_FROM_REPLY_CONFIG` path). */
		this.env = env;
		/** Extra CLI args for the child (e.g. `--provider fake --model fake-mini`). */
		this.args = args;
		/** Every parsed stdout object, in arrival order. */
		this.events = [];
		/** Only `extension_ui_request` events (dialogs + fire-and-forget). */
		this.uiRequests = [];
		this.stderr = "";
		this.exited = false;
		this.exitInfo = undefined;
		this.pending = new Map();
		this.child = undefined;
	}

	async start() {
		const args = [...this.launcher.args, "--mode", "rpc", ...extensionArgs(this.args)];
		this.child = spawn(this.launcher.command, args, {
			cwd: this.cwd,
			// The settings file is per scenario by default: the path points inside the throwaway
			// workspace, which has no such file, so the real agent-dir config never leaks in.
			env: childEnv({ [CONFIG_ENV]: join(this.cwd, CONFIG_FILE), ...this.launcher.env, ...this.env }),
			stdio: ["pipe", "pipe", "pipe"],
			shell: this.launcher.shell,
			windowsHide: true,
		});
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk) => {
			this.stderr += chunk;
		});
		this.child.on("exit", (code, signal) => {
			this.exited = true;
			this.exitInfo = { code, signal };
			for (const { reject } of this.pending.values()) {
				reject(new Error(`pi exited (code ${code}, signal ${signal})`));
			}
			this.pending.clear();
		});
		const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
		lines.on("line", (line) => this.#handleLine(line));
		// Let pi boot far enough to own its stdin reader before the first command is written.
		await sleep(150);
		return this;
	}

	#handleLine(line) {
		const trimmed = line.trim();
		if (trimmed.length === 0) return;
		let parsed;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			return; // stray stdout noise (banner, etc.)
		}
		this.events.push(parsed);
		if (parsed.type === "extension_ui_request") this.uiRequests.push(parsed);
		if (parsed.type === "response" && parsed.id !== undefined) {
			const waiter = this.pending.get(parsed.id);
			if (waiter) {
				this.pending.delete(parsed.id);
				waiter.resolve(parsed);
			}
		}
	}

	#write(object) {
		if (!this.child?.stdin.writable) throw new Error("pi stdin is not writable");
		this.child.stdin.write(`${JSON.stringify(object)}\n`);
	}

	/** Send a command and await its correlated `response` line. */
	send(command, { timeout = 120_000 } = {}) {
		const id = randomUUID();
		const promise = new Promise((resolveResponse, rejectResponse) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				rejectResponse(new Error(`Timed out after ${timeout}ms waiting for response to ${command.type}`));
			}, timeout);
			this.pending.set(id, {
				resolve: (response) => {
					clearTimeout(timer);
					resolveResponse(response);
				},
				reject: (error) => {
					clearTimeout(timer);
					rejectResponse(error);
				},
			});
		});
		this.#write({ ...command, id });
		return promise;
	}

	/** Reply to an `extension_ui_request`: `{ value }`, `{ confirmed }` or `{ cancelled: true }`. */
	respond(id, body) {
		this.#write({ type: "extension_ui_response", id, ...body });
	}

	async prompt(message) {
		return await this.send({ type: "prompt", message });
	}

	async getMessages() {
		const response = await this.send({ type: "get_messages" });
		return response.success ? response.data.messages : [];
	}

	async userTexts() {
		const messages = await this.getMessages();
		return messages.filter((message) => message.role === "user").map(messageText);
	}

	/** Wait until the agent has no turn in flight. */
	async waitForSettled({ timeout = 180_000 } = {}) {
		const startIndex = this.events.length;
		await poll(
			() =>
				this.exited ||
				this.events.slice(startIndex).some((event) => event.type === "agent_settled") ||
				this.events.slice(startIndex).some((event) => event.type === "message_end" && event.message?.role === "assistant"),
			{ timeout, label: "agent turn to settle" },
		);
		if (this.exited) throw new Error(`pi exited during the turn: ${JSON.stringify(this.exitInfo)}`);
	}

	/** Fire-and-forget notifications the extension emitted. */
	notifications() {
		return this.uiRequests
			.filter((request) => request.method === "notify")
			.map((request) => request.message);
	}

	/**
	 * `ui.setStatus` updates in order. This is the progress channel for hosts without an
	 * overlay — `setWorkingMessage` is a no-op in RPC — so a scenario asserts on it to prove
	 * the extraction reports itself while it runs and clears the line afterwards.
	 */
	statusLines() {
		return this.uiRequests
			.filter((request) => request.method === "setStatus")
			.map((request) => request.statusText);
	}

	/** Dialogs that expect an answer (select/input/confirm/editor). */
	dialogs() {
		return this.uiRequests.filter(
			(request) => request.method === "select" || request.method === "input" || request.method === "confirm",
		);
	}

	async abort() {
		try {
			await this.send({ type: "abort" }, { timeout: 30_000 });
		} catch {
			// already gone
		}
	}

	async stop() {
		if (!this.child || this.exited) return;
		this.child.stdin.end();
		this.child.kill("SIGTERM");
		const gone = await Promise.race([
			new Promise((done) => this.child.once("exit", () => done(true))),
			sleep(5_000).then(() => false),
		]);
		if (!gone) {
			this.child.kill("SIGKILL");
			await Promise.race([new Promise((done) => this.child.once("exit", done)), sleep(2_000)]);
		}
	}

	/** Last non-empty assistant text, mirroring what the extension extracts from. */
	async lastAssistantText() {
		const messages = await this.getMessages();
		for (let i = messages.length - 1; i >= 0; i -= 1) {
			const text = messages[i].role === "assistant" ? messageText(messages[i]).trim() : "";
			if (text.length > 0) return text;
		}
		return "";
	}
}

/**
 * Create an empty working directory for one scenario, run `body`, then remove it.
 * On failure the directory is kept and its path reported so the run can be replayed.
 */
export async function withEmptyWorkspace(body) {
	const cwd = await mkdtemp(join(tmpdir(), "afr-e2e-"));
	let succeeded = false;
	try {
		const value = await body(cwd);
		succeeded = true;
		return value;
	} catch (error) {
		// Keep the directory so the failure can be replayed; report where it is.
		const note = `\n[e2e] kept failing scenario directory: ${cwd}`;
		if (error instanceof Error) error.message += note;
		throw error;
	} finally {
		if (succeeded) await rm(cwd, { recursive: true, force: true, maxRetries: 3 });
	}
}


