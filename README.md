# ask-from-reply

Turn the questions in the assistant's last reply into an interactive questionnaire, then
hand the answers back as one compact message.

A reply like

```
Which cache should we use for the index?

1. No cache
2. Memory cache with TTL
3. Disk cache across runs
```

becomes a dialog with one question and three options. Picking the second one appends
`Cache → 2` to the conversation instead of making you retype the question and answer.

## Use

- `ctrl+shift+a` — ask from the last reply.
- `/ask-from-reply` — same thing by name.

Both work on the **last assistant reply only**, and need an idle session. The questions are
extracted by a side model call, so a reply that asks nothing reports `The last reply asks no
questions` and nothing is sent. If the call fails or times out you get
`Could not extract questions: …` with the reason — including the case where the model's JSON
is structurally unusable, e.g. `question 1 has no "options" list`.

The answers go back as one line per question:

```
Cache → 2
Features: logging, metrics | note: behind a flag for now
note: ship it tomorrow
```

`→` means numbered picks, `:` means free text, ` | note: …` is a per-question note, and a
lone `note: …` line is the questionnaire-wide note.

## The dialog

| Key | Does |
| --- | --- |
| `1`–`9` | pick an option (answers it, and submits when it was the last question); in a multi-select question it toggles the option |
| `↑` `↓` | move between options |
| `Tab` / `←` `→` | switch question tabs, including `Submit` |
| `Enter` | confirm; on `Submit` it sends |
| `p` | on `Submit`: flip between the answer summary and the exact text that will be sent (one view at a time) |
| `n` | add a note (question note, or the questionnaire-wide note on the last tab) |
| `ctrl+]` | collapse the dialog while keeping it alive |
| `Esc` | cancel — nothing is sent |

The last option of every question is `Type something.`, which opens a one-line input so a
free-text answer is never more than a keystroke away.

Hosts that cannot render the dialog (RPC, print, ACP) ask the same questions one at a time
through their own select/input requests, and show the extraction progress in the status
line instead of a spinner — `setStatus` is the one progress surface those hosts render.

## Settings

`ask-from-reply.config.json` in pi's agent directory — the one that holds
`settings.json` (`~/.pi/agent/`) — read on every run. `ASK_FROM_REPLY_CONFIG` takes a full
path instead, which is how the tests stay off a real config. Copy
`ask-from-reply.config.example.json` from this package to get started; a missing file means
defaults, silently.

| Key | Default | Meaning |
| --- | --- | --- |
| `submit` | `"send"` | `"send"` posts the answers; `"editor"` only fills the input box so they can be edited (TUI only — other hosts always send) |
| `extractionModel` | session model | `"provider/modelId"` for the extraction call, e.g. `"openai/gpt-4o-mini"`; unavailable models fall back to the session model with a warning |
| `extractionTimeoutMs` | `60000` | extraction deadline, 1 s – 10 min |
| `maxQuestions` | `4` | question cap, 1–9; also stated in the extraction prompt |
| `maxOptions` | `4` | option cap per question, 2–9; also stated in the extraction prompt |
| `replyTailChars` | `1000` | only the last N characters of the reply are shown to the extractor (50 – 100 000), so a huge reply cannot blow up the call |

Anything unusable — bad JSON, an unknown `submit`, a number out of range — falls back to
that key's default and reports one warning; a missing file is not a problem.

## License

MIT — see [`LICENSE`](LICENSE).

The dialog under `src/vendor/` is derived from
[`@juicesharp/rpiv-ask-user-question`](https://github.com/juicesharp/rpiv-mono) 2.15.0
(MIT, © 2026 juicesharp), vendored because that package registers its tool as
`model-only` and exports no UI. Which files are verbatim, which are modified, and the
upstream license text are in [`NOTICE`](NOTICE).

## Tests

```bash
npm test          # unit tests only, offline
npm run typecheck # tsc over every source file
npm run e2e       # 19 scenarios over `pi --mode rpc`
npm run e2e:tui   # 3 scenarios in a real terminal under herdr-core
npm run verify    # all four, in that order: the full gate
```

Both e2e suites drive a real pi process against a **fake** model (`tests/e2e/fake-model.mjs`
behind `tests/e2e/fake-provider.ts`), so replies, extraction output, delays and failures are
scripted and the suites are deterministic and free. See `tests/e2e/README.md`.

The e2e suites run pi processes in parallel (`AFR_E2E_CONCURRENCY`, default 8;
`AFR_E2E_TUI_CONCURRENCY`, default 3), which is what keeps them near their single-scenario
cost instead of multiplying it by the number of scenarios.
