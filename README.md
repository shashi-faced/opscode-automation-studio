# @opscode/automation-studio

Opscode Automation Studio agent: automate a web app module feature by feature. Every action is
recorded as a node (what it does, inputs, target element, the page it led to), nodes are linked
into a flow (in order, with yes/no branches), flows are grouped under features, and every flow can
be replayed with self-healing selectors. The Opscode Graph tab shows it all, live while recording.

## How it works

- **Recorder daemon.** `automation_record_start` starts a small background process
  (`opscode-automation recorder-daemon`) that stays attached to the browser over CDP for the whole
  recording, so every page and new tab is recorded. Status and stop talk to it through files in
  `~/.opscode/run/` (`OPSCODE_AUTOMATION_RUN_DIR` overrides).
- **Browser.** Opscode's own browser (the Browser tab, headless or headed) when it is running;
  otherwise a Chrome the agent starts. `OPSCODE_AUTOMATION_CDP_PORT` points at a specific browser.
- **Who acts.** The user clicks and types in the browser, or the agent calls `automation_step`
  (goto, click, fill, select, check, uncheck, press, assert_text, assert_url, assert_visible, wait,
  decision). Both are recorded.
- **Flow format v2** (`automation/features/<feature>/<flow>/flow.json`): `steps` are the nodes
  (`id`, `action`, `label`, `description`, `selectorSet`, `value` / `key` / `url`, `page`, `result`,
  `source`, `condition`), `edges` link them (`next`, or `yes` / `no` from a decision), `entry` is the
  first node. Older flat flows load as a straight line.
- **Secrets.** Typed passwords are saved as `{{secret:<flow>.<field>}}`; the values go to
  `automation/.secrets.json` (git-ignored). Runs can override them with `inputs`.
- **Replay** walks the graph from the entry, evaluates decisions, and checks that each action that
  changed the page during recording reaches the same page again (ids in paths are ignored).
  Clicks use real mouse events, checked, with an in-page fallback if the page never got them (see
  `src/flow/input.mjs`).
- **Test data** (`src/data/`). Every fill/select node has a data rule (`data`): `generate` (a new
  realistic value of a kind each run: email, fullName, phone, company, number, date, zip, text,
  a pattern like `ORD-{n:5}`, ...), `fixed` (sign-in, search, codes), `list`, `any` (a random
  select option) or `secret`. Rules are suggested when a flow is saved and changed with
  `automation_flow_data`. Replays use fresh data by default; a generated value also replaces the
  recorded one later in the flow (assert texts, "confirm email", links to the new record). Values
  are unique against `automation/data/history.json` and saved with each run (`dataUsed`), so
  `replayRun` can repeat a failed run with the same data.
- **Issues** (`src/issues/tracker.mjs`). A failed run opens an issue per failing node and cause in
  `automation/issues/issues.json` (and a readable `ISSUES.md`): error, category, what the page
  said, failed requests, console errors, data used, screenshot, how to reproduce. open → fixed
  (developer) → closed by the next passing run; a failure after that reopens it as a regression.

## Tools

| Tool | What it does |
| --- | --- |
| `automation_module_plan` | Lay out a module as features and flows (+ order between flows) |
| `automation_record_start` | Start recording a flow (or a branch of a saved flow with `branchOf`) |
| `automation_step` | Do one action in the browser; recorded as a node while recording |
| `automation_record_status` | Live state of the recording, including its graph |
| `automation_record_stop` | Save the flow (+ Playwright spec) under its feature (`rejoin` for branches) |
| `automation_flow_get` | A saved flow's nodes and edges, and its last run |
| `automation_flow_run` | Replay a flow (`data`: fresh/recorded, `times`, `replayRun`, `inputs`, `untilNode`, `fromNode`) |
| `automation_flow_data` | Show or change the test data rule of each form field, with sample values |
| `automation_issues` / `automation_issue_update` | List tracked failures; mark fixed / won't fix, note, assignee |
| `automation_batch_run` | Run all flows of a feature in dependency order |
| `automation_flow_match` | Find a saved flow for a request |
| `automation_graph_get` / `_save` | Module graph (project, features, flows, layout, dependencies) |
| `automation_feature_create` / `automation_flow_create` | Add a feature / flow by hand |
| `automation_flow_compile` | Playwright spec of the main path |
| `automation_flow_accept_fix` | Keep a healed selector |
| `automation_visual_diff` / `automation_audit` / `automation_doctor` | Pixel diff, WCAG audit, diagnostics |

## CLI

```bash
node bin/opscode-automation.mjs agent-manifest
node bin/opscode-automation.mjs tool <name> --b64 <base64 json> --cwd <workspace>
```

The last stdout line is the JSON result `{ ok, text, data }`.

## Testing

```bash
npm test
```

`test/e2e.test.mjs` starts a headless Chrome and a 4-page test site (`test/fixtures/site.mjs`),
records a journey the way the app does (one CLI process per call), replays it, records an agent
flow with a decision and its other branch, and lays out a module. It is skipped when no
Chrome/Chromium is installed.
