# @opscode/automation-studio

Opscode Automation Studio agent: zero-extension browser test automation, self-healing Playwright execution, visual regression diffing, and WCAG accessibility auditing.

## Architecture & Features

- **No Chrome Extension Required**: Connects directly to Opscode's built-in browser via Chrome DevTools Protocol (`DevToolsActivePort`).
- **In-Page Floating Widget**: Injects an isolated Shadow DOM widget (`#opscode-recording-sidebar-root`) with Pause, Undo, and Stop recording controls without interfering with page CSS.
- **5-Layer Self-Healing Selector Engine**: Resiliently resolves dynamic UI elements:
  1. `PRIMARY`: `data-testid`, `data-cy`, `data-qa`
  2. `ARIA`: semantic role + accessible name
  3. `TEXT`: visible text content
  4. `CSS`: optimal minimal unique CSS path
  5. `XPATH`: hierarchical DOM path fallback
- **Deterministic DOM Scanning Healing (Layer 6A)**: If all 5 selector layers fail, scans interactive elements (`button`, `a`, `input`, etc.) against step description semantics to recover broken selectors.
- **Playwright Test Runner & Compiler**: Replays test flows with step-by-step progress tracking, auto-generates clean, human-readable Playwright test files (`.spec.ts`) with `expect()` assertions.
- **Local Pixelmatch Visual Regression**: Compares baseline vs current screenshots, reporting changed pixel count, mismatch percentage, and highlighting discrepancies in diff images.
- **Axe-Core WCAG Accessibility Audits**: Evaluates pages against WCAG 2.1 AA/AAA compliance offline, generating categorized violation reports with impact ratings and remediation guidelines.

## Available Agent Tools

1. `automation_record_start`: Start an interactive recording session on a URL in Opscode's browser.
2. `automation_record_stop`: Conclude recording, save JSON flow, and compile a standalone `.spec.ts`.
3. `automation_record_status`: Check active recording state, URL, and captured step count.
4. `automation_flow_run`: Replay a recorded test flow with 5-layer self-healing and DOM scanning.
5. `automation_flow_compile`: Convert a recorded `flow.json` into an idiomatic Playwright test file.
6. `automation_visual_diff`: Compare two screenshots with diff highlighting and mismatch percentage.
7. `automation_audit`: Run WCAG accessibility compliance check on the current or specified page.
8. `automation_doctor`: Diagnostics for Chrome and Playwright environments.

## Testing

```bash
npm test
```
