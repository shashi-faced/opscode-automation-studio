# Automation Studio: make recording, flow graphs and replay work

Goal: automate a large app or website module feature by feature. Each action is recorded as a
node (what it does, inputs, target, result), nodes are linked into a flow (sequence and
branches), the flow shows live in the Opscode Graph tab, and it can be saved and replayed. A
module is organised as several feature flows.

## What I found (2026-11-18, v0.1.0 + 4 later commits)

Tried end to end against a local 4-page test site (`test/fixtures/site.mjs`: sign in, dashboard,
new order form with text/select/checkbox, orders list), the same way the app calls the agent
(`node bin/opscode-automation.mjs tool <name> --b64 <json> --cwd <ws>`):

1. **Recording loses everything after the first page.** Each tool call is its own Node process.
   `automation_record_start` registers the in-page recorder (`addInitScript`, `exposeFunction`)
   on its own CDP connection and then exits, so Chrome drops both. A 9-action journey saved
   4 steps (fill email, fill password, click Sign in); dashboard, order form and list were lost.
   `automation_record_status` during the journey showed only 1 step.
2. **Replay "passes" a cut-short flow and checks nothing.** The 4-step flow replayed as
   `SUCCESS 4/4` with no check that the click led to the dashboard.
3. **Flows are flat step lists.** No node ids, no edges, no branches, no recorded result per
   step. The Graph tab only draws project, feature and flow cards, never the steps.
4. **Passwords saved in plain text** in `flow.json` (`"value": "secret"`).
5. **Wrong browser.** The app's own browser is headless (shown in the Browser tab, which
   forwards clicks and typing). The agent treats a headless port as unusable and opens a
   separate Chrome window with a different profile (no logins), so recording from chat never
   happens where the user is looking.
6. **The agent cannot act and record itself.** There is no tool to click or type, so "automate
   this module" from chat depends on the user doing every step by hand.
7. **App side:** the Graph tab runs the CLI through a hard-coded path search instead of the
   installed package, passes JSON inside single quotes (breaks on `'`), writes a fake
   "Example Domain Check" project into the user's workspace when none exists, and has no live
   view of the steps while recording.

Existing tests (51) pass, but they are unit tests with mocked pages; none records across pages.

## Phases

**P1. Recorder daemon (fixes 1).** `automation_record_start` starts a detached
`recorder-daemon` process that holds the CDP connection for the whole recording: context-wide
init script + binding, so every page and new tab is recorded. Steps go to a session file
(`~/.opscode/run/automation-session.json`); status reads that file (fast, no browser).
`automation_record_stop` asks the daemon to flush and save, then waits for it. The in-page widget's
Stop/Pause/Undo talk to the daemon.

**P2. Flow graph format v2 (fixes 3, 4).** `flow.json` keeps `steps` (for the compiler and the
step drawer) and adds `nodes` + `edges`. A node has id, action, label, inputs, target (selector
set), page and result (URL and title after the action). Edges are `next`, or `yes` / `no` from a
`decision` node. Navigations caused by an action become that action's result, not extra nodes.
Password values are replaced by `{{secret:<name>}}` and kept in `automation/.secrets.json`
(git-ignored). Old flat flows load as a straight line.

**P3. Agent can drive and record (fixes 6).** New `automation_step` tool: goto, click, fill,
select, check, uncheck, press, assert_visible, assert_text, assert_url, wait, decision. During a
recording each step is recorded as a node with the agent's description. `decision` adds a branch
point. New `automation_flow_get` returns a flow's nodes and edges. Recording can continue a branch
of an existing flow (`branchOf`), and `automation_flow_run` can stop at a node (`untilNode`).

**P4. Replay walks the graph (fixes 2).** The runner follows edges, evaluates decision
conditions, checks that an action that changed the page during recording lands on the same path,
fills secrets and inputs, and reports results per node id.

**P5. Browser choice (fixes 5).** Use the Opscode browser whenever it is up, headless or not;
only open our own Chrome when none is running. `OPSCODE_AUTOMATION_CDP_PORT` overrides the port.
Logs go to stderr so the last stdout line stays the JSON result.

**P6. Module organisation.** `automation_module_plan` creates a module's features and empty
flows in one call; flow-to-flow `depends-on` edges order a batch run (already there).

**P7. App Graph tab (fixes 7).** Run tools through the installed package (with cwd, base64
params), stop writing a sample project, add a flow view that draws the step nodes and edges
(branches labelled yes/no, coloured by last run), shown live while recording, opened from a flow
card.

**P8. Tests.** Agent: end-to-end test that records the 4-page journey across processes,
replays it, checks the order was created, plus branch and secrets tests. App: QA test for the
flow-graph builder and the tool-call plumbing.

## Status (2026-11-18)

P1 to P8 are done. Evidence: `test/e2e.test.mjs` (real Chrome, CLI one process per call) records
the 4-page journey as 9 connected nodes, replays it (a second order is created), fails at node n4
with a clear message when the password is wrong, records an agent flow with a decision, adds its
"no" branch, replays the right branch, and lays out a module. `npm test`: 67/67. App QA test
`tests/automation_studio_qa_test.js`: 16/16.

Found while testing, and handled in the agent:
- The widget script threw at document start (no `<body>` yet) and stopped the recorder script on
  every new page. The widget now mounts on DOMContentLoaded, and the two scripts run separately.
- A page left over from an earlier recording kept that recording's id; re-injection now switches it.
- The 320×480 widget covered page controls in the Browser tab's small view; it now starts as a bar.
- `automation_flow_create` lost its flow when it had to create the feature (saved a stale project).
- Input checks: replay and `automation_step` confirm each click and typed value reached the page and
  do it in the page if it did not (`src/flow/input.mjs`). Chrome 157 headless sometimes drops all
  CDP mouse and key input to a page reached by a redirect (e.g. the dashboard after sign-in). On
  2026-11-19 I wrongly called this a test artifact; on 2026-11-20 it reproduced with a bare Chrome and
  a raw CDP client, no agent attached (`--headless=new` with the Opscode switches; about 1 run in 4,
  every run under full CPU load). The agent's own clicks and typing are covered by the checks above.

## Not in scope now

- Recording inside cross-origin iframes.
- Compiling decision branches into the Playwright spec (spec stays the main path).

---

# Part 2 (2026-11-20): fresh test data on every run, and failures tracked for developers

## Problem
A recorded form replays with the exact values typed while recording. The second replay of
"Register customer" sends the same email again: the app rejects it ("already registered"), or the
test creates duplicate records that hide real bugs. A failed run leaves only a run folder; nobody can
see which failures are new, which were fixed, or which came back.

## Design

**D1. A data rule per form field** (`node.data` on fill and select nodes):
`{ mode: "generate" | "fixed" | "list" | "any" | "secret", kind, why, source: "auto" | "ai" | "user" }`.
- `generate`: a new value every run, of a kind: email, fullName, firstName, lastName, username,
  phone, number, date, company, street, city, zip, url, sentence, text (keeps the recorded shape:
  digits re-rolled, a short unique tag added), or `pattern` (e.g. `"ORD-{n:5}"`, `"{firstName} QA"`).
- `fixed`: the recorded value (sign-in forms, search boxes, coupon/OTP codes).
- `list`: one of `values` per run. `any` (select): a random real option. `secret`: from .secrets.json.
- Rules are suggested when a flow is saved (input type, label, name, autocomplete, recorded value,
  a sign-in form on the same page) with a reason in `why`; the agent (AI) reviews and changes them
  with the new tool `automation_flow_data`, or passes `data` with `automation_step`.

**D2. Replay uses fresh data by default.** `automation_flow_run { data: "fresh" | "recorded",
times: N, replayRun: <runId> }`. Values are made per run from a seed; uniqueness is checked against
`automation/data/history.json`. A generated value replaces the recorded value wherever it appears
later in the flow (assert texts, a "confirm email" field, a link to the new record's name), so
checks keep working. Every run saves the values it used (`dataUsed`, secrets masked) in its
run-summary.json; `replayRun` reruns with exactly those values, so a developer can reproduce a
failure. `times` runs the flow N times with different data.

**D3. Failures become tracked issues** (`automation/issues/issues.json`, readable
`automation/issues/ISSUES.md`). A failed run opens an issue per failing node, or adds to the open
one with the same fingerprint (flow + node + error shape). An issue has: flow, feature, node, error,
category (app-rejected-input, server-error, element-not-found, wrong-result, page-load,
missing-data), the messages the page showed (alerts, field validation text), failed requests
(method, URL, status) and console errors around the step, the data used, screenshot, run folder,
AI diagnosis, and how to reproduce (`replayRun`). Status: open, fixed (developer), closed
(verified by a passing run after "fixed"), wont_fix. A run that passes the node again closes a
"fixed" issue; a failure after "fixed" or "closed" reopens it as a regression.
Tools: `automation_issues` (list/filter) and `automation_issue_update` (status, note, assignee).

**D4. App Graph tab.** Fill nodes show their data rule (🎲 email / fixed) and the value used in the
last run; the flow toolbar gets an Issues panel (open issues of the flow or of all flows, with
"Mark fixed" and "Re-run with same data") and the Replay button uses fresh data.

**D5. Tests.** Unit tests for the generator, rule inference, substitution and the issue lifecycle;
the e2e fixture gets a "register customer" form that rejects a repeated email and a switchable
server bug, and the e2e test proves: recorded data fails on the second run, fresh data passes 3
runs in a row, a bug opens one issue with the page message and failed request, marking it fixed
and passing closes it, and replayRun reuses the data.

## Status of part 2 (2026-11-20)

D1 to D5 are done (agent 0.3.0, Store entry 0.3.0). Evidence:
- `test/test_data.test.mjs` (20 checks): generator formats and seeds, rule suggestions (sign-in vs
  sign-up, search, number, company, ...), copy fields, substitution into later texts and targets,
  history uniqueness, replay data, spec output, issue lifecycle (open, same failure again, separate
  cause, fixed -> closed, regression, flaky pass), and the three new tools.
- `test/e2e.test.mjs` (real Chrome, 12 subtests): a "Register customer" form recorded by the agent
  gets rules email/fullName/phone/company; replaying with the recorded data fails with "Email
  already registered" and opens an app-rejected-input issue; 3 fresh runs pass with 3 different
  customers; a server bug opens a high-severity server-error issue with the failing POST/GET 500;
  marked fixed + `replayRun` with the same data closes it; the bug coming back reopens it.
- App: `tests/automation_studio_qa_test.js` 22/22; step nodes show the rule (🎲/📌) and the
  last run's value; Replay has New test data / New data ×3 / Recorded data; Issues panel.

The e2e failures seen on 2026-11-20 were the Chrome input drop above hitting the test's simulated
user (raw CDP clicks, like the app's Browser tab). The test's user now clicks after paint, checks
that the page saw it, and after 3 lost clicks clicks or types in the page. 3/3 runs under full CPU
load pass (before: every loaded run failed). The agent's own replays never needed that.

Open (app side, not changed here): the Opscode Browser tab forwards the user's clicks over CDP the
same way, so after a redirect a user's click can be lost in that tab. Worth checking in the app.

---

# Part 3 (2026-11-24): from "replays what I did" to "tests my module"

1. **Negative and boundary tests.** `automation_flow_negative { flow, fields?, cases? }` derives
   wrong inputs per form field from its data rule (invalid email, empty, too long, short phone,
   past/invalid date, number out of range, ...). Each case replays the flow with that one value
   changed, up to the step that "accepts" the form (the first later step whose recorded result
   was a new page, or the first later assert). Pass = the app refused it (stayed, showed a
   message or the browser blocked it); fail = the app accepted it -> issue `validation-missing`.
2. **Data between flows.** Variables: a fill node can publish its run value (`exportAs`), an
   `extract` step reads text from the page (target and optional regex) into a variable, and any
   value can use `{{var:name}}` (or rule `{ mode: "var", name }`). Variables persist in
   `automation/data/vars.json`, so "Create order" uses the customer "Register customer" made.
3. **Data sets.** `automation_flow_run { dataset: "file.csv" }` runs once per row; columns map to
   fields by node id or field name; a per-row report.
4. **Cleanup.** `automation_cleanup { flow, field?, cleanupFlow? | request? }` deletes what runs
   created (values in the data history not yet cleaned), through a recorded cleanup flow (value
   in `{{var:cleanup.value}}`) or an HTTP request template; cleaned values are marked.
5. **Issues to GitHub.** `automation_issue_export { id, repo? }` opens a GitHub issue with `gh`
   (after the user agrees); `automation_issue_sync` closes the loop: a closed ticket marks the
   issue fixed, and the next passing run closes it.
6. **Rule editor** in the Graph tab: click a step's data badge to change its rule.
7. **Run history.** `automation_run_history { flow?, feature?, limit? }`: pass rate, flaky steps,
   slowest steps, from saved runs; a History panel in the Graph tab.
8. **Nightly regression.** A routine for Automation Studio ("run all flows with new data and
   report failures, new issues and regressions"), created from the Graph tab.
9. **More actions:** upload (file), hover, dialog (accept/dismiss, prompt text), iframes (`frame`
   on a step), drag (to a target). The recorder records uploads, dialogs, drags and steps inside
   frames.
10. **Server checks.** During recording, non-GET requests that follow an action are saved on the
    node (`result.requests`); replay checks the same request happened and succeeded, and reports
    "POST /api/notes -> 500" or "no request sent".
11. **Explore.** `automation_explore { url, maxPages }`: crawls same-site links, lists pages,
    forms (fields) and buttons, and proposes features and flows (`apply: true` lays them out).
12. **Export.** `automation_export { dir }`: a Playwright project (config, one spec per flow and
    branch path, data generator, CI workflow) that runs the same flows with new data.

Tests: unit tests per part; the e2e fixture site gains an API notes page (fetch), an iframe, an
upload, a confirm dialog, drag-and-drop and a hover menu; e2e subtests cover each.

## Status of part 3 (2026-11-24)

All 12 items are done (agent 0.4.0, 28 tools; Store entry 0.4.0). Evidence:
- `test/e2e_actions.test.mjs` (real Chrome): a note saved through `fetch` keeps `POST /api/notes`
  on its Save node; replay fails with "Server call failed: POST /api/notes -> 500" when the API
  breaks; `extract` + `{{var:note.id}}` in a URL; a confirm dialog answered by the agent and one
  recorded from the user; upload (placeholder file), drag and drop, hover menu, a form in an
  iframe; an order flow uses the customer the previous flow registered (`exportAs` / rule var).
- `test/e2e_more.test.mjs`: negative tests (browser- and server-refused values pass; a phone the
  app accepts opens a validation-missing issue, fixed + re-run closes it; an unescaped name runs a
  script -> script-injection issue), a CSV data set with expected failures, cleanup by HTTP and by
  a cleanup flow, run history (flaky steps), explore + lay out, Playwright export, GitHub
  export/sync with a stand-in `gh`.
- `test/part3.test.mjs` (unit): cases, acceptance point, verdicts, CSV, variables, server checks,
  labels, branch paths, spec output, issue body.
- App: rule editor (click a field's data badge), History panel, Nightly routine button,
  "Invalid data" button, server calls / published variables / iframe on nodes. QA 27/27.

Found and fixed while testing: values typed by a replay leaked into the next recording on the same
tab (fields are now baselined when recording starts); the recorder inside an iframe recorded the
agent's typing too (muted in all frames now); a dialog's server call is sent while the action
before it runs (checked from that step); a flow ending with a form submit could be cut off by the
next run (it waits for the page change now); cleanup now deletes only records of runs that
completed. Every tool also takes `workspace` (routines run in their own folder).
