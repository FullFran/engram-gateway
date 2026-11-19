/**
 * Aggregate-only results table from run files. Per-query rows are never
 * read, so the output is safe to publish.
 */
const SOURCES = ['implicit', 'judged'];
const fmt = value => (value === null || value === undefined ? 'n/a' : value.toFixed(3));

export function renderReport(runs) {
  const lines = [
    '| Engine | Split | Labels | Labeled queries | Recall@5 | Recall@10 | MRR | Zero-result rate |',
    '|---|---|---|---:|---:|---:|---:|---:|',
  ];
  const sorted = [...runs].sort((a, b) =>
    a.summary.split.localeCompare(b.summary.split) || a.summary.label.localeCompare(b.summary.label));
  for (const source of SOURCES) {
    for (const { summary } of sorted) {
      const m = summary[source];
      if (!m) continue;
      lines.push(`| ${summary.label} | ${summary.split} | ${source} | ${m.labeled} | ${fmt(m.recallAt5)} | ${fmt(m.recallAt10)} | ${fmt(m.mrr)} | ${fmt(m.zeroResultRate)} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}
