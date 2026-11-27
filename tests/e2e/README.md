# End-to-end tests

Two suites, both driving a **real** pi process against a **fake** model. pi, the extension,
the RPC protocol and the TUI are real; the model is a scripted HTTP server, so every reply,
extraction output, delay and failure is chosen by the test.

| Command | What it proves |
| --- | --- |
| `npm run e2e` | 20 scenarios over `pi --mode rpc`: extraction → questionnaire → compact answer envelope back in the conversation, plus both settings-file locations and every extractor failure mode |
| `npm run e2e:tui` | 3 scenarios in a real terminal under herdr-core: the dialog mounts, a digit answers it, the answer line reaches the transcript; the Submit tab shows one preview at a time and `p` flips it; `submit: "editor"` parks the answers in the input box and sends nothing until enter |

`npm test` stays offline and unit-only: the files here are named `*.e2e.mjs` on purpose, so
`node --test tests/` does not pick them up.

## The fake model

`fake-model.mjs` is an OpenAI-compatible endpoint on `127.0.0.1` that answers the two kinds
of request a scenario makes:

- **main** turns (the assistant reply being questioned) → the scenario's `reply`;
- **extraction** calls (system prompt says `You convert the questions …`) → the scenario's
  `extract`, which may also be a function returning `{ text, delayMs }` or
  `{ status, text }` to script a slow or failing model.

`fake-provider.ts` is a tiny second extension (loaded with `-e` only by these tests) that
calls `pi.registerProvider("fake", …)` and points it at that server. That is why the suite
needs no credentials: `--model fake/fake-mini` always exists.

Why not a `models.json`? Because pointing pi at a temporary one costs a throwaway
`PI_CODING_AGENT_DIR`, which pi fills with installed packages and cloned repos. Why not
`streamSimple`? Because hand-built provider events depend on pi internals, while HTTP + SSE
is the path the extension actually runs on in production.

Every request is recorded, so assertions can look at what the extractor was really asked
(`lastUserText`, `systemText`) and how many turns were made.

## Requirements

- `npm run e2e` needs nothing beyond Node.
- `npm run e2e:tui` needs `hc` on `PATH` (herdr-core) and `bash` (the fake provider's URL has
  to be exported into the terminal, and `hc run` has no environment option); it skips
  without them.
- Windows note: the harness spawns `node <cli.js>` directly (resolved from
  `~/.pi/agent/install/current-version`, or `$PI_CLI`). It does not use `pi-launcher.js`,
  whose `spawnSync` wrapper would make the child unkillable — and `spawnSync` itself hangs
  on pi, which keeps its stdio pipes open through grandchildren.

## Cost and speed

Nothing is paid for and no network is used. Wall time depends on the machine, so it is not
quoted here; what matters is that the suites are dominated by pi startup (one process per
scenario) plus a couple of turns. The cheapest speedup is therefore running scenarios at the
same time — which `node:test` will only do if the **parent** test carries `concurrency`:
subtests are sequential regardless of `Promise.all`, and a semaphore alone changes nothing.
Beyond that the TUI suite polls and waits for a turn counter instead of sleeping through
fixed delays; the only remaining fixed wait is the quiet period that proves
`submit: "editor"` sent nothing.

| Command | Parallel pi processes |
| --- | --- |
| `npm test` | — |
| `npm run typecheck` | — |
| `npm run e2e` | `AFR_E2E_CONCURRENCY`, default 8 |
| `npm run e2e:tui` | `AFR_E2E_TUI_CONCURRENCY`, default 3 |

Do not raise the caps to something like 32: the extra time saved is not worth the CPU
contention, which shows up as flaky TUI screens rather than failures with useful output.

## Isolation

Every scenario runs in a **fresh empty `mkdtemp` directory** with:

```
--no-session --no-extensions --no-skills --no-context-files --approve -e <this package> -e <fake-provider.ts>
```

`--no-extensions` only disables discovery, so the explicit `-e` paths still load — exactly
this extension plus the fake provider, and nothing else from the user's setup. Inherited
`PI_PROVIDER` / `PI_MODEL` / `PI_SESSION_FILE` are stripped (they out-rank the CLI) and
`NO_PROXY` is set for loopback. On success the directory is deleted; on failure it is kept
and its path is appended to the error (`[e2e] kept failing scenario directory: …`) so the
transcript can be replayed.

## Settings

The extension reads its settings from pi's agent directory, so every scenario points
`ASK_FROM_REPLY_CONFIG` at a path inside its own workspace — by default one that does not
exist (defaults), and scenarios that test settings write a throwaway file beside it. A real
`~/.pi/agent/ask-from-reply.config.json` therefore cannot change what a test sees. RPC
sessions get it through the spawned process environment. `hc run` has no environment option, so the TUI suite wraps pi in
`bash -c 'export …; exec node <cli.js> …'` — `exec` keeps it one process, so the address
`hc` returns is pi itself.

## Files

- `harness.mjs` — spawn/isolation, the JSONL RPC client, temp workspaces.
  The client is hand-written because pi's own `RpcClient` cannot answer
  `extension_ui_request`s programmatically.
- `fake-model.mjs` — the scripted model (HTTP + SSE) and the request log.
- `fake-provider.ts` — the e2e-only extension that registers it as `fake/fake-mini`.
- `scenarios.mjs` — the 20 RPC scenarios (`prompt`, scripted replies, answer script,
  assertions), the shared envelope assertions and the settings-file plumbing.
- `rpc.e2e.mjs`, `tui.e2e.mjs` — `node:test` entry points (`npm run e2e`, `npm run e2e:tui`).

## The 20 RPC scenarios

Happy paths: numbered single select (`Cache → 2`), multi-select with custom text
(`1, 3 | custom text`), `Type something.` answered with free text (`Cache: PascalCase`),
free text typed over the option list, cancel (no message, only a notification), a reply with
no questions, an empty multi-select submission (no message).

A reply that asks nothing with a `?` but lists numbered next steps (`后续可以执行：` then
`1. … 2. … 3. …`) is a question too: the scenario asserts the extractor saw the whole list
plus the introducing line, that the prompt calls a numbered list a question and a multi-select
one, and that two of the three steps can be picked at once. Because the extracted question text
is the model's wording, not the reply's, the numbered echo cannot anchor and the answer degrades
to the labels (`Next: Run the full test suite, Commit the change`).

Settings: `submit: "editor"` degrades to a send outside the TUI; a missing
`extractionModel` falls back to the session model with a warning.

Extractor boundaries, all reported as `Could not extract questions: …` with no dialog:

- no JSON at all, and balanced-but-invalid JSON (two different messages);
- a question with no `options` list (used to reach the user as `Cannot read properties of
  undefined (reading 'map')`), and a `questions` value that is not a list (used to be
  reported as “The last reply asks no questions”);
- a reserved option label (`Other`);
- more questions than `maxQuestions`, and more options than `maxOptions` — each asserts the
  cap was also stated in the extraction prompt;
- an extraction that never answers in time (`extractionTimeoutMs` fires on a fake reply that
  arrives far too late);

Plus two structural checks: a long reply reaches the extractor as **exactly** its last
`replyTailChars` characters, and the extraction request carries only the prompt and the tail
(`["system", "user"]`, no conversation history).

## What is asserted, and what is not

Assertions are **structural**:

- the message the extension sends is non-empty and is a bare list of compact answer lines —
  no `Answers (Qn = …)` header, no `(skipped)` rows;
- at most one line per extracted question, no duplicated keys;
- every line is `Key → 1, 3`, `Key: text`, optionally followed by ` | note: …`;
- a `→` line carries numbers only (plus optional multi custom text), a `:` line carries free
  text — custom answers are never numbered;
- cancel / nothing-to-ask / empty submission send **no** user message, only a notification;
- the extraction progress reaches the status line (`setStatus`) and is cleared on both the
  success and the failure path.

Answers are driven by the dialogs that actually arrive (`select` / `input`), not by guessing
what was asked, so reworded questions cannot break the suite — only a changed envelope
contract can.

The Submit tab previews the exact text it will send. `tests/submit-preview.test.mjs` pins the
cheap half (`formatAnswersCompact` → `sentTextLines` are the message's own lines, no
re-wording); the TUI test pins the visible half by reading the rows off the terminal, in both
preview modes, and then finding them in the transcript after submitting.

## Shared host behaviors worth remembering

- The extension command's RPC `response` only arrives **after** the questionnaire is over
  (the handler awaits it), so the test never awaits it before answering the dialogs.
- `sendUserMessage` starts a new turn; the RPC harness aborts it right after reading the
  envelope to avoid a pointless follow-up turn.
- `ctx.ui.custom()` returns `undefined` in RPC without ever running its factory, which is why
  the loader falls back to running the work directly (and to `setStatus`) instead of waiting
  for a dialog that will never render.
- In the TUI, `hc send` wraps text in `<hc from=…>`, so the shortcut (`ctrl+shift+a`) and the
  answer keys are pressed with `hc keys` instead of pasted.
