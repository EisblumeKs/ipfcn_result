(() => {
  'use strict';
  const style = document.createElement('style');
  style.textContent = ".rd-probe-overlay, .rd-tooltip { pointer-events: none; }\n.rd-probe-line {\n  stroke: var(--rd-chart-muted);\n  stroke-width: 1.15;\n  stroke-dasharray: 4 4;\n}\n.rd-probe-point { fill: var(--rd-paper); stroke: currentColor; stroke-width: 2; }\n.rd-tooltip {\n  position: absolute;\n  z-index: 1;\n  padding: 5px 7px;\n  border: 1px solid var(--rd-frame);\n  border-radius: 3px;\n  background: var(--header);\n  box-shadow: 0 2px 7px var(--menu-shadow);\n  color: var(--text);\n  font: 12px/1.4 var(--sans);\n  font-variant-numeric: tabular-nums;\n  white-space: nowrap;\n}\n.rd-tooltip[hidden] { display: none; }\n.rd-probe-value { display: block; margin-bottom: 2px; font-size: 13px; font-weight: 700; }\n.rd-probe-rank { display: flex; align-items: baseline; gap: 3px; color: var(--muted); }\n.rd-probe-group { margin-right: auto; font-weight: 600; }\n.rd-probe-percent { color: var(--text); }\n@media print { .rd-tooltip, .rd-probe-overlay, .rd-probe-target { display: none; } }\n";
  document.head.append(style);

  function lowerBound(values, x, pairs = false) {
    let lo = 0, hi = values.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if ((pairs ? values[mid][0] : values[mid]) < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function densityAt(estimate, layout, x) {
    const {curve, bars} = estimate;
    if (!curve.length) {
      const index = Math.floor((x - layout.first) / layout.width);
      if (Math.abs(x - (layout.first + bars.length * layout.width)) < 1e-8) return bars[bars.length - 1];
      return bars[index] || 0;
    }
    const i = lowerBound(curve, x, true);
    if (!i) return curve[0][1];
    if (i === curve.length) return curve[i - 1][1];
    const [x0, y0] = curve[i - 1], [x1, y1] = curve[i];
    return y0 + (x - x0) * (y1 - y0) / (x1 - x0);
  }

  function svgPart(tag, className) {
    const part = document.createElementNS('http://www.w3.org/2000/svg', tag);
    part.setAttribute('class', className);
    return part;
  }
  function textPart(tag, className, text = '') {
    const part = document.createElement(tag);
    part.className = className;
    part.textContent = text;
    return part;
  }

  let active;
  function dismiss() { active?.hide(); }
  document.addEventListener('pointerdown', event => {
    if (active && !active.target.contains(event.target)) dismiss();
  }, {capture: true, passive: true});
  window.addEventListener('hashchange', dismiss);
  window.addEventListener('pagehide', dismiss);

  window.IPFcnChartProbe = (figure, svg, target, options) => {
    const {width, height, top, bottom, layout, samples, estimates, px, py, en, isGL, tooltipWidth} = options;
    const overlay = svgPart('g', 'rd-probe-overlay');
    overlay.setAttribute('aria-hidden', 'true');
    const line = svgPart('line', 'rd-probe-line');
    line.setAttribute('y1', top);
    line.setAttribute('y2', bottom);
    overlay.append(line);
    const tip = textPart('div', 'rd-tooltip');
    tip.setAttribute('role', 'tooltip');
    tip.style.width = tooltipWidth + 'px';
    const valueText = textPart('strong', 'rd-probe-value');
    tip.append(valueText);
    const series = samples.map(sample => {
      const point = svgPart('circle', 'rd-probe-point rd-' + sample.color);
      point.setAttribute('r', 4);
      overlay.append(point);
      const row = textPart('div', 'rd-probe-rank');
      if (isGL) {
        const label = textPart('span', 'rd-probe-group rd-' + sample.color, en ? sample.gender : sample.label);
        label.setAttribute('aria-label', sample.label);
        row.append(label);
      }
      const percent = textPart('span', 'rd-probe-percent');
      percent.dataset.gender = sample.gender;
      row.append(textPart('span', '', en ? 'Top' : '前'), percent);
      tip.append(row);
      return {point, percent};
    });
    svg.append(overlay);
    figure.append(tip);

    const {xmin, xmax} = layout;
    let current, tipHeight;
    const scale = isGL ? 100 : 10;
    function readableValue(x) {
      const step = Math.min(Math.floor(xmax * scale + 1e-8),
        Math.max(Math.ceil(xmin * scale - 1e-8), Math.round(x * scale)));
      return step / scale;
    }
    function pointerValue(clientX, bounds) {
      const span = xmax - xmin;
      const x = xmin + Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width)) * span;
      // A single screen pixel can span several marks. Prefer an actual result within that pixel.
      let best = readableValue(x), distance = span / bounds.width * .75;
      for (const {values} of samples) {
        const i = lowerBound(values, x);
        for (const neighbor of [values[i - 1], values[i]]) {
          if (Math.abs(neighbor - x) <= distance) {
            best = neighbor;
            distance = Math.abs(neighbor - x);
          }
        }
      }
      return best;
    }

    const probe = {target, hide, show};
    function hide() {
      tip.hidden = true;
      overlay.setAttribute('visibility', 'hidden');
      if (active === probe) active = undefined;
    }
    function show(input) {
      if (active !== probe) dismiss();
      const bounds = target.getBoundingClientRect();
      if (!bounds.width) return;
      let value;
      if (input.key) {
        value = current ?? samples[0].values[Math.floor(samples[0].values.length / 2)];
        const step = isGL ? .1 : 2.5;
        if (input.key === 'Home') value = xmin;
        if (input.key === 'End') value = xmax;
        if (['ArrowLeft', 'ArrowDown'].includes(input.key)) value -= step;
        if (['ArrowRight', 'ArrowUp'].includes(input.key)) value += step;
        value = readableValue(value);
      } else {
        value = pointerValue(input.x, bounds);
      }
      if (active === probe && current === value) return;
      current = value;
      active = probe;
      tip.hidden = false;
      overlay.removeAttribute('visibility');
      const x = px(Math.max(xmin, Math.min(xmax, value)));
      line.setAttribute('x1', x);
      line.setAttribute('x2', x);
      valueText.textContent = isGL ? value.toFixed(2) + ' GL' : value + ' kg';
      const spoken = [valueText.textContent];
      let upperPoint = bottom;
      for (const [i, {values, label}] of samples.entries()) {
        const y = py(densityAt(estimates[i], layout, value));
        const {point, percent} = series[i];
        point.setAttribute('cx', x);
        point.setAttribute('cy', y);
        upperPoint = Math.min(upperPoint, y);
        const count = values.length - lowerBound(values, value);
        percent.textContent = Number((100 * count / values.length).toFixed(1)) + '%';
        spoken.push((isGL ? label + ' ' : '') + (en ? 'Top ' : '前 ') + percent.textContent);
      }
      target.setAttribute('aria-valuenow', value);
      target.setAttribute('aria-valuetext', spoken.join(' · '));
      tipHeight ||= tip.offsetHeight;
      const tipY = Math.min(bottom - tipHeight, Math.max(top, upperPoint - tipHeight / 2));
      tip.style.left = 'calc(' + 100 * x / width + '% + 6px)';
      tip.style.top = 100 * tipY / height + '%';
    }
    return probe;
  };
})();
