# Relevance rubric (judged labels)

Written before judging. Applies to the pooled subset built by `eval/pool.mjs`.

## Unit

One verdict per (query, candidate observation). Binary: **relevant** or **not relevant**.
The judge sees the query, its scope (project or all projects) and a text excerpt of each
candidate. Candidates are shuffled per query; the judge does not see which engine
configuration returned them, their rank, or the implicit labels.

## Intent

Read the query as what an agent wanted to recall at that moment. Agents write keyword
bags; take the most specific terms (names, issue numbers, tools, errors) as the
intent, and the generic ones (`decision`, `architecture`, `gotcha`, `bugfix`) as
weak hints about the kind of memory.

## Relevant

The observation is one the agent would want to open to answer that intent:

1. It states the decision, fact, procedure, error, or state the specific terms point
   to, for the same subject (same project, tool, component, or issue); or
2. It is a session summary or progress record whose main subject is that intent,
   when the query asks for status, progress, or what was done.

## Not relevant

- It shares words with the query but is about another subject.
- It mentions the subject only in passing.
- It is a generic summary, checkpoint, or passive capture that does not answer the
  intent.
- Its scope contradicts the query's explicit project (unless the query searched all
  projects).

## Edge cases

- Several near-duplicate observations on the same fact: each is relevant.
- Vague query (no specific term): relevant only when the observation clearly matches
  every term that carries meaning; otherwise none is relevant.
- A query with no relevant candidate is valid and kept: it has no relevant id, so it
  enters the zero-result rate but not recall or MRR. Its count is reported.

## Bias statement

Judged labels only cover the pool (top-10 of the pooled configurations). An engine
that finds relevant observations outside that pool is not credited until the pool is
extended with its results and the new candidates are judged with this rubric.
