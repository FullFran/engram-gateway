# Recall evaluation

A reproducible, engine-agnostic measure of how well memory search finds what
agents look for. It replays real `mem_search` queries that agents issued
against any MCP endpoint and scores the ranked ids. Engram's default search and
`match_mode=any` are the baselines; hybrid search (#15) and the gateway's
`/mcp` are scored by the same scripts.

## Privacy

Query texts and observation content are private. The scripts keep them in a
data directory outside the repository, `~/.local/share/engram-gateway-eval/`
(override with `--data` or `EVAL_DATA_DIR`), created with mode `0700` and files
`0600`. They print counts and aggregate metrics only. The repository holds
code, the rubric, synthetic test fixtures and aggregate tables, never query
text, ids of real observations or memory content.

Run engines against a copy of the Engram database, never the live one:

```sh
scratch=$(mktemp -d)
mkdir "$scratch/engram"
sqlite3 -readonly ~/.engram/engram.db ".backup $scratch/engram/engram.db"
```

and pass `--engram-data-dir "$scratch/engram"` to every engine command.

## Pipeline

| Step | Command | Writes (data directory) |
|---|---|---|
| 1. Dataset | `npm run eval:build` | `searches.jsonl`, `dataset.json` |
| 2. Pool | `npm run eval:pool -- --engram-data-dir <copy>` | `pool.json`, `judge/batch-NN.md` |
| 3. Judge | read `judge/*.md` with `eval/RUBRIC.md`, write `verdicts/*.txt` | `verdicts/*.txt` |
| 4. Merge | `npm run eval:judgments` | `judgments.json` |
| 5. Score | `npm run eval:run -- --label <name> --split dev ...` | `runs/<label>.<split>.json` |
| 6. Review | `npm run eval:review -- --engram-data-dir <copy>` | `review-sample.md` |
| 7. Report | `npm run eval:report` | prints the markdown table |

### 1. Dataset

`eval/build-dataset.mjs` reads Claude Code transcripts (default
`~/.claude/projects`, subagent transcripts included) and joins every Engram
`mem_search` call with its result.

- **Implicit labels.** Consecutive searches with no fetch between them form a
  chain. An observation is relevant to every search of the chain when the
  agent fetched it with `mem_get_observation`, or cited it as `#<id>` (only
  ids the chain showed), within `--window` tool calls (default 6) after the
  chain's last search.
- **Status.** Each search is `fetched`, `reformulated` (followed by another
  search of the chain) or `abandoned`; `zeroResult` flags an empty original
  result.
- **Dedupe.** Queries are deduplicated on lowercase, whitespace-collapsed
  text. The first occurrence fixes the text and the replay scope (project,
  `all_projects`, type); labels are the union over occurrences.
- **Split.** Each query goes to `dev` or `holdout` (default 30%) by a keyed
  hash of its normalized text with `--seed` (default `engram-gateway-eval-v1`),
  so the split is fixed and independent of input order. Query ids are opaque
  (`q_` plus 12 hex characters of the same keyed hash).

Implicit labels only contain what the original engine showed the agent, so
they favour that engine. Judged labels exist to correct that.

### 2-4. Judged labels

`eval/pool.mjs` samples `--n` queries (default 150, seeded) and pools the
top-`--k` results (default 10) of each `--modes` configuration (default
`all,any`). Candidates are shuffled per query with no engine or rank, so the
judge is blind. The judge applies `eval/RUBRIC.md`, written before judging,
and writes one line per query:

```text
q_0123456789ab: 812 77
q_ba9876543210: -
```

`eval/merge-judgments.mjs` checks that every pooled query has a verdict and
that every relevant id is one of its candidates, then writes
`judgments.json`:

```json
{ "version": 1, "rubric": "eval/RUBRIC.md",
  "queries": { "q_0123456789ab": { "relevant": [77, 812], "judged": [12, 77, 812] } } }
```

Judged labels are pooled: an engine that finds relevant observations outside
the pool is not credited until its new candidates are judged. Extend the pool
with `--modes` before comparing a new engine on judged labels.

### 5. Scoring

```sh
npm run eval:run -- --label engram-default --split dev --engram-data-dir <copy>
npm run eval:run -- --label engram-any --match-mode any --split dev --engram-data-dir <copy>
EVAL_MCP_TOKEN=... npm run eval:run -- --label gateway --transport http --url https://host/mcp --split dev
npm run eval:run -- --label hybrid --tool mem_search_hybrid --split dev --engram-data-dir <copy>
```

Engine options:

| Option | Default | Meaning |
|---|---|---|
| `--transport` | `stdio` | `stdio` spawns `--command --command-args`; `http` uses Streamable HTTP |
| `--command`, `--command-args` | `engram`, `mcp` | stdio server command |
| `--engram-data-dir` | | sets `ENGRAM_DATA_DIR` for the stdio server |
| `--url`, `--token-env` | , `EVAL_MCP_TOKEN` | HTTP endpoint and the variable holding its bearer token |
| `--tool` | `mem_search` | search tool name |
| `--match-mode` | | adds `match_mode` to every search |
| `--search-args` | | JSON object merged into every search |
| `--limit` | `10` | results per search |

The stdio server runs with `/` as its working directory, so Engram's
working-directory project detection never changes the scope.

Metrics, per label source (`implicit`, `judged`):

- **recall@k**: share of a query's relevant ids in the top k, averaged over
  queries with at least one relevant id.
- **MRR**: mean reciprocal rank of the first relevant id (0 when none is
  returned).
- **zero-result rate**: share of queries with an empty result, over every
  query of the label source (judged: the judged queries).

**Holdout discipline.** Tune on `dev`. The holdout runs once per `--label`:
`holdout-ledger.json` records each run and refuses a second one unless
`--force-holdout` is passed, which is recorded as forced.

## Baseline

Engram 3.7.2, a read-only copy of one real brain (13,306 observations), 2,162
transcripts, 784 searches, 475 unique queries (dev 347, holdout 128), 245 with
implicit labels, 150 judged queries (117 with a relevant candidate, 1,381
judged pairs).

| Engine | Split | Labels | Labeled queries | Recall@5 | Recall@10 | MRR | Zero-result rate |
|---|---|---|---:|---:|---:|---:|---:|
| engram-any | dev | implicit | 182 | 0.498 | 0.587 | 0.463 | 0.063 |
| engram-default | dev | implicit | 182 | 0.357 | 0.382 | 0.332 | 0.499 |
| engram-any | holdout | implicit | 63 | 0.493 | 0.633 | 0.488 | 0.039 |
| engram-default | holdout | implicit | 63 | 0.296 | 0.360 | 0.350 | 0.547 |
| engram-any | dev | judged | 84 | 0.775 | 0.943 | 0.832 | 0.093 |
| engram-default | dev | judged | 84 | 0.405 | 0.467 | 0.518 | 0.495 |
| engram-any | holdout | judged | 33 | 0.727 | 0.955 | 0.748 | 0.070 |
| engram-default | holdout | judged | 33 | 0.279 | 0.289 | 0.415 | 0.605 |

Reading it:

- Default search returns nothing for about half of the real queries: agents
  write keyword bags and the default mode requires every term.
- Judged recall@10 near 0.95 for `any` is an upper bound by construction: the
  pool is the union of both configurations' top 10, so what neither found is
  never judged. Compare a new engine on judged labels only after adding its
  results to the pool.
- Implicit labels come from searches that often used `match_mode=any`
  originally, so they also favour `any`.
- One judge (an LLM, following the rubric) produced the judged labels;
  `review-sample.md` holds 30 of them for a human spot check.
