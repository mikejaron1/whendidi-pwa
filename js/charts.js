/* Chart creation is separate from view markup and statistical aggregation. */
(function () {
  'use strict';

  function theme() {
    const tokens = getComputedStyle(document.documentElement);
    Chart.defaults.color = tokens.getPropertyValue('--ink-soft').trim();
    Chart.defaults.borderColor = tokens.getPropertyValue('--rule').trim();
  }

  function bar(canvas, { labels, values, label, color, integer = true, xTitle = '' }) {
    theme();
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `${label}. ${labels.map((name, index) =>
      `${name}: ${values[index] == null ? 'not observed' : values[index]}`).join('; ')}`);
    return new Chart(canvas, {
      type: 'bar',
      data: { labels, datasets: [{ label, data: values, backgroundColor: color, borderRadius: 4 }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { title: { display: !!xTitle, text: xTitle } },
          y: { beginAtZero: true, ticks: integer ? { precision: 0 } : {} },
        },
      },
    });
  }

  window.CWCHARTS = { theme, bar };
})();
