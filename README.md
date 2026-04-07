# analyticscli

Agent-friendly CLI for querying analytics, exporting events, and working with project-scoped read access in AnalyticsCLI.

Using a coding agent: you can let it handle CLI setup, auth, and query workflows end-to-end with the AnalyticsCLI skills repo:
https://github.com/Wotaso/analyticscli-skills

The same skills can also be used with OpenClaw.

Current npm release channel: preview / experimental beta.
If no stable release exists yet, `latest` points to the newest preview.
Once stable releases exist, `latest` is pinned to the newest stable.

## Skills

Available AnalyticsCLI skills:

- [`analyticscli-cli`](https://github.com/Wotaso/analyticscli-skills/tree/main/skills/analyticscli-cli): CLI setup, auth, query workflows, exports
- [`analyticscli-ts-sdk`](https://github.com/Wotaso/analyticscli-skills/tree/main/skills/analyticscli-ts-sdk): SDK integration/upgrades for JS/TS, React Native, Expo
- ClawHub: `ai-product-manager` is the canonical published skill

## Run With npx

No global install is required:

```bash
npx @analyticscli/cli@preview onboard
```

When stable releases are available, use the package without a dist-tag:

```bash
npx @analyticscli/cli onboard
```

Optional global install for daily usage:

```bash
npm install -g @analyticscli/cli@preview
```

## Quick Start

You need:

- a `readonly_token` (read-only CLI scope)
- a `project_id` (from `analyticscli projects list`)

Interactive setup (recommended):

```bash
npx @analyticscli/cli@preview onboard
```

Non-interactive login:

```bash
npx @analyticscli/cli@preview login --readonly-token <readonly_token>
```

Then run your first queries:

```bash
npx @analyticscli/cli@preview projects list
npx @analyticscli/cli@preview schema events --project <project_id>
npx @analyticscli/cli@preview funnel --project <project_id> --steps onboarding:start,onboarding:complete --last 30d
npx @analyticscli/cli@preview timeseries --project <project_id> --metric event_count --interval 1d --last 30d --viz table
npx @analyticscli/cli@preview generic --project <project_id> --metric event_count --group-by day,eventName --last 30d
```

## Troubleshooting Empty States

No projects listed (`analyticscli projects list` returns empty):

1. Create your first project in [dash.analyticscli.com](https://dash.analyticscli.com).
2. Run `analyticscli projects list`.
3. Set a default with `analyticscli projects select`.

Project exists but no events yet (`analyticscli schema events --project <project_id>` returns empty):

1. Integrate `@analyticscli/sdk` in your app codebase.
2. Initialize SDK with your project publishable API key from **Dashboard -> API Keys**.
3. Emit at least one event from the app.
4. Re-run `analyticscli schema events --project <project_id> --last 14d`.

## Common Commands

### Core analytics

```bash
analyticscli funnel --project <project_id> --steps onboarding:start,onboarding:complete --last 30d
analyticscli conversion-after --project <project_id> --from onboarding:start --to purchase:success --last 30d
analyticscli retention --project <project_id> --anchor-event onboarding:start --days 1,7,30 --last 30d
analyticscli survey --project <project_id> --last 30d
```

### Flexible grouped query

```bash
analyticscli generic \
  --project <project_id> \
  --metric event_count \
  --group-by day,eventName,country \
  --events onboarding:start,onboarding:complete \
  --last 30d \
  --order-by value_desc
```

### Event export

```bash
analyticscli events months --project <project_id> --year 2026
analyticscli events export --project <project_id> --year 2026 --month 2 --out ./events-2026-02.csv
analyticscli events export-range --project <project_id> --last 90d --out ./events-last-90d.csv
```

### Product feedback

```bash
ANALYTICSCLI_CLI_ENABLE_WRITE_COMMANDS=true analyticscli feedback submit --message "Session detail view needs raw JSON" --category feature --context "dashboard/settings"
```

## Output Modes

Use `--format json` for scripts/agents and `--format text` for local reading.

Query commands include a confidence/sample-size hint:

- `matchedRecords` in JSON output
- `matched records: ...` in text summaries

Examples:

```bash
analyticscli projects list --format json
analyticscli timeseries --project <project_id> --metric event_count --last 7d --format text
```

Global options available on all commands:

- `--api-url <url>` override API base URL
- `--token <token>` override stored token for one command
- `--format json|text` choose output mode
- `--include-debug` include debug/dev data on supported reads
- `--quiet` reduce text output noise

## Authentication Notes

- `readonly_token` is for query/export usage.
- It is different from SDK write keys used for event ingestion.
- `analyticscli setup` and `analyticscli onboard` can install `analyticscli-cli` and `analyticscli-ts-sdk` for Codex/Claude Code. When `--agents openclaw` is selected, they install the canonical ClawHub skill `ai-product-manager`.

## Auto Maintenance

- CLI startup checks for newer CLI versions once per day and shows an update hint in text mode.
- In interactive terminals, the update prompt supports `y` (update now), `n` (ask later), and `a` (skip this offered version).
- When the CLI binary version changes, the CLI auto-refreshes the `analyticscli-cli` skill.
- ClawHub skill updates are handled by ClawHub; the CLI does not refresh hidden or unpublished ClawHub-only skills.
- Automatic refresh intentionally does **not** force-update the `analyticscli-ts-sdk` skill, because SDK versions in app codebases can lag intentionally.

## Releases

Use npm package versions and GitHub Releases in the public CLI repository as
the source for release history.
