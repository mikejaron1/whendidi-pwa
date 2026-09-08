/* Portable, offline HTML summaries contain no remote assets or user scripts. */
(function () {
  'use strict';
  const esc = (value) => window.CWUI.escapeHtml(value);
  const THEME = `
:root {
  color-scheme: light;
  --cp-bg: #f7f4ef;
  --cp-bg-elevated: #fcfbf8;
  --cp-surface: #ffffff;
  --cp-surface-soft: #f5f5f5;
  --cp-border: #dedede;
  --cp-border-strong: #919191;
  --cp-text: #242424;
  --cp-text-muted: #5c5c5c;
  --cp-text-soft: #6f6f6f;
  --cp-accent: #b11f4b;
  --cp-accent-hover: #9a1a41;
  --cp-accent-soft: rgba(177, 31, 75, 0.08);
  --cp-accent-fg: #ffffff;
  --cp-success: #16a34a;
  --cp-danger: #dc2626;
  --cp-warning: #f59e0b;
  --cp-link: #0078d4;
  --cp-shadow: 0 18px 48px rgba(0, 0, 0, 0.12);
  --cp-overlay: rgba(255, 255, 255, 0.8);
  --cp-panel: rgba(255, 255, 255, 0.86);
  --cp-panel-strong: rgba(255, 255, 255, 0.96);
  --cp-sheen: rgba(255, 255, 255, 0.55);
  --cp-highlight: rgba(177, 31, 75, 0.12);
}
html[data-theme="dark"] {
  color-scheme: dark;
  --cp-bg: #3d3b3a;
  --cp-bg-elevated: #343231;
  --cp-surface: #292929;
  --cp-surface-soft: #2e2e2e;
  --cp-border: #474747;
  --cp-border-strong: #5f5f5f;
  --cp-text: #dedede;
  --cp-text-muted: #919191;
  --cp-text-soft: #b0b0b0;
  --cp-accent: #fd8ea1;
  --cp-accent-hover: #fb7b91;
  --cp-accent-soft: rgba(253, 142, 161, 0.14);
  --cp-accent-fg: #1a1a1a;
  --cp-success: #4ade80;
  --cp-danger: #f87171;
  --cp-warning: #fbbf24;
  --cp-link: #4da6ff;
  --cp-shadow: 0 18px 48px rgba(0, 0, 0, 0.32);
  --cp-overlay: rgba(41, 41, 41, 0.88);
  --cp-panel: rgba(41, 41, 41, 0.72);
  --cp-panel-strong: rgba(41, 41, 41, 0.96);
  --cp-sheen: rgba(255, 255, 255, 0.04);
  --cp-highlight: rgba(253, 142, 161, 0.12);
}`;

  function build({ topics, events, measurements, kinds = {}, prefs = {}, from, to, findings = [], cutoffHour = 0 }) {
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
      throw new Error('Choose a valid summary date range.');
    }
    const selected = events.filter((event) => event.time >= from && event.time < to)
      .sort((a, b) => a.time - b.time);
    const byId = new Map(topics.map((topic) => [topic.id, topic]));
    const byUnit = new Map(measurements.map((measurement) => [measurement.id, measurement]));
    const number = (value) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
    const valueOf = (event) => {
      const topic = byId.get(event.topicid);
      const unit = byUnit.get(topic?.msureid);
      if (kinds[event.topicid] === 'timeonly') return '';
      if (kinds[event.topicid] === 'duration' || (!kinds[event.topicid] && unit?.type === 3)) {
        return `${number(Number(event.qant || 0) / 60)} min`;
      }
      return `${number(Number(event.qant || 0))} ${unit?.symbol || ''}`.trim();
    };
    const summaries = topics.map((topic) => {
      const rows = selected.filter((event) => event.topicid === topic.id);
      if (!rows.length) return '';
      const aggregation = prefs[topic.id]?.aggregation || 'sum';
      const raw = rows.map((event) => Number(event.qant || 0));
      const value = aggregation === 'latest' ? raw[raw.length - 1]
        : raw.reduce((sum, n) => sum + n, 0) / (aggregation === 'mean' ? raw.length : 1);
      return `<tr><th scope="row">${esc(topic.name)}</th><td>${rows.length}</td>
        <td>${kinds[topic.id] === 'timeonly' ? '' : `${esc(aggregation)}: ${esc(valueOf({ topicid: topic.id, qant: value }))}`}</td></tr>`;
    }).join('');
    const rows = selected.map((event) => `<tr>
      <td>${esc(new Date(event.time).toLocaleString())}</td>
      <td>${esc(byId.get(event.topicid)?.name || 'Unknown topic')}</td>
      <td>${esc(valueOf(event))}</td><td>${event.cost ? esc(event.cost) + '/5' : ''}</td>
      <td class="note">${esc(event.note || '')}</td></tr>`).join('');
    const dates = `${CWSTATS.logicalDate(from, cutoffHour)} - ${CWSTATS.logicalDate(to - 1, cutoffHour)}`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<script>(() => {
  const param = new URLSearchParams(window.location.search).get("scoutTheme");
  const theme = param || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", theme);
})();</script>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Plotline summary - ${esc(dates)}</title><style>${THEME}
*{box-sizing:border-box}body{margin:0;background:var(--cp-bg);color:var(--cp-text);font:16px/1.6 "Segoe UI",Aptos,Calibri,-apple-system,BlinkMacSystemFont,sans-serif}
main{max-width:1100px;margin:32px auto;padding:24px;background:var(--cp-surface);border:1px solid var(--cp-border);border-radius:16px}
h1,h2{line-height:1.3}h1{color:var(--cp-accent)}p{color:var(--cp-text-muted)}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;margin:16px 0}th,td{text-align:left;vertical-align:top;padding:8px;border-bottom:1px solid var(--cp-border)}th{background:var(--cp-surface-soft)}.note{white-space:pre-wrap;overflow-wrap:anywhere;min-width:180px}button{font:inherit;background:var(--cp-accent);color:var(--cp-accent-fg);border:0;border-radius:.625rem;padding:12px 20px;cursor:pointer}
@media print{button{display:none}main{margin:0;max-width:none;border:0;padding:0}tr{break-inside:avoid}.table-wrap{overflow:visible}body{font-size:11pt}}
</style></head><body><main>
<h1>Plotline summary</h1><p>${esc(dates)} · ${selected.length} entries · ${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)}</p>
<p>Logical days begin at ${esc(String(Math.floor(cutoffHour)).padStart(2, '0'))}:${esc(String(Math.round((cutoffHour % 1) * 60)).padStart(2, '0'))} local time. Entry timestamps show their actual calendar dates.</p>
<button type="button" onclick="window.print()">Print / save as PDF</button>
<h2>Topics</h2><div class="table-wrap"><table><thead><tr><th>Topic</th><th>Entries</th><th>Measured value</th></tr></thead><tbody>${summaries}</tbody></table></div>
<h2>Associations in this date range</h2>${findings.length ? `<ul>${findings.map((finding) => `<li>${esc(finding.text)}</li>`).join('')}</ul>` : '<p>No supported findings for this selection.</p>'}
<p>These are observations from a personal log, not diagnoses or evidence of cause and effect. Missing or incomplete logs can affect results. Discuss health decisions with a qualified clinician.</p>
<h2>Entries and notes</h2><div class="table-wrap"><table><thead><tr><th>When</th><th>Topic</th><th>Value</th><th>Severity</th><th>Note</th></tr></thead><tbody>${rows}</tbody></table></div>
<p>Contains personal information. Share only with people you choose. This summary is not a restorable backup; use Export JSON to preserve your complete data.</p>
</main></body></html>`;
  }

  function download(html, name) {
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  window.CWREPORT = { build, download };
})();
