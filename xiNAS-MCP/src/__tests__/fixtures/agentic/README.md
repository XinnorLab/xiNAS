# Agentic health-check acceptance fixtures (S19d)

One JSON file per anonymized incident scenario, run by
`src/__tests__/lib/health/agentic-fixtures.test.ts`. The runner asserts what
the validator (`health.report.validate`) and the tool log say about a
report — verdict, integrity, outcomes, finding kinds and references,
forbidden calls — never prose (requirements §10, spec §15/§16).

## File name

`ac-NN-<slug>.json`, lower case, starting with the scenario id. A captured
run from a real host goes in as `ac-NN-<host>-<n>.json` with the same
shape and its own `expected`.

## Shape

| Key | Meaning |
|---|---|
| `id`, `title`, `scope` | the requirement id (`AC-NN`), a one-line title, `node` or `service_path` |
| `declared_absent` | what `health.context.topology.declared_absent` said for the run |
| `ledger` | the raw reports xiNAS produced for the run, keyed by a short name: `{ tool, args, collected_at?, report }`; the runner records each in a fresh `RunLedger` entry, so their digests are the ground truth |
| `tool_log` | the calls the model made, in order: `{ tool, args? }` |
| `report` | the model's report; may use the placeholders below and may omit the `run` / `scope` blocks (defaults are filled) |
| `expected` | what must hold (see below) |
| `variant_uncited` | optional: `{ report: overlay, expected }` — the same report with top-level keys replaced (`checks` merged by id) and its own expectation |
| `previous` | optional: an earlier scenario for the same node (AC-20); with `expected.run_ids_differ` the runner asserts the two runs are distinct |

### Placeholders

- `"run": { "run_id": "$run" }` — the run id the runner minted.
- `raw_reports[]`: `{ "$ledger": "<key>" }` copies that ledger item (tool,
  args, collected_at, digest and report). Adding `"report": {…}` next to
  `$ledger` keeps the ledger's digest but substitutes the report — this is
  how a fixture tampers with a raw report (AC-19).
- `"digest": "$auto"` on an explicit raw report computes a self-consistent
  digest (a report xiNAS never produced: `not_in_ledger`).
- `checks[]`: a row `{ "*": "pass", "reason": "…", "evidence_refs": […] }`
  expands to every mandatory row of the scope not listed explicitly, with
  that outcome, reason and evidence. Explicit rows are always written out.

### `expected`

| Key | Assertion |
|---|---|
| `valid`, `computed`, `integrity` | the validator's `valid`, `computed` (`null` when the schema failed) and `integrity.status` |
| `integrity_reasons` | the mismatch reasons, in order |
| `reference_errors`, `status_errors` | counts |
| `rewritten_to_unknown` | the exact list |
| `run_status` | the report's `run_status` |
| `checks` | `{ "<id>": "<outcome>" }` for named rows |
| `checks_forbid_outcomes` | `{ ids: […], outcomes: […] }` — none of the ids may carry one of the outcomes |
| `findings` | `min`, `kinds_include`, `resource_ids_include`, `check_ids_include` |
| `not_checked_mentions`, `not_checked_min` | substrings that must appear in some `not_checked` row; a minimum count |
| `evidence_excerpt_includes` | substrings that must appear in some `evidence_manifest[].excerpt` |
| `forbidden_calls` | `{ tool?: "<name>" \| "*", args?: {…} }` patterns that must not match any `tool_log` entry (`args` is a subset match) |
| `tools_from_catalog` | every `tool_log[].tool` is a catalog entry name (or `prompts/get`) |
| `max_calls_per_tool` | no tool called more often than this |
| `ledger_preserves` | `{ key, pointer, equals }` — the ledger's raw report still holds the original value at that JSON pointer |
| `execution_roles_ran_length` | the report's `run.execution.roles_ran` length |
| `run_ids_differ` | with `previous`: the two runs have different ids |

## Anonymization

Hostnames, controller ids, array and disk names, paths, principals and
timestamps are invented (`nas-01`, `arr-data`, `nvme3n2`, `/mnt/data`,
`op:alice`, `2026-09-09T10:…Z`). No serial numbers, licence material or
customer text.
