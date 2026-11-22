(() => {
  'use strict';

  const preferences = new WeakMap();
  const distributionCache = new Map();
  const sqrtTwoPi = Math.sqrt(2 * Math.PI);
  const names = {
    squat: ['蹲举', 'Squat'], bench: ['卧推举', 'Bench press'],
    deadlift: ['硬举', 'Deadlift'], total: ['总成绩', 'Total'], gl: ['GL系数', 'GL points'],
    M: ['男子', 'Men'], F: ['女子', 'Women']
  };

  function element(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  }

  function svgElement(tag, attrs, content) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    if (content !== undefined) node.textContent = content;
    return node;
  }

  function groupClass(row) {
    const value = row.placement_weight_class || row.weight_class;
    if (row.gender === 'F' && value === '43') return '47';
    if (row.gender === 'M' && value === '53') return '59';
    return rankingWeightClass(row.gender, value);
  }

  function compareClasses(a, b) {
    return parseFloat(a) - parseFloat(b) || Number(a.endsWith('+')) - Number(b.endsWith('+'));
  }

  function bestByAthlete(rows, metric) {
    const best = new Map();
    for (const row of rows) {
      if (!Number.isFinite(row[metric]) || row[metric] <= 0) continue;
      const previous = best.get(row.athlete_id);
      if (!previous || row[metric] > previous[metric]) {
        best.set(row.athlete_id, row);
      }
    }
    return [...best.values()];
  }

  function resultPeriod(row) {
    const from = row.date_precision === 'year' ? String(row.year)
      : row.meet_date || row.meet_start || String(row.year);
    const to = row.date_precision === 'year' ? from
      : row.meet_end_date || (!row.meet_date && row.meet_end) || from;
    return {start: from.length === 4 ? from + '-01-01' : from,
      end: to.length === 4 ? to + '-12-31' : to,
      label: from === to ? from : from + ' – ' + to};
  }

  function firstPerformances(rows, metric) {
    const max = rows.reduce((best, row) => Number.isFinite(row[metric]) ? Math.max(best, row[metric]) : best, 0);
    if (!max) return [];
    const results = rows.filter(row => row[metric] === max).map(row => ({row, period: resultPeriod(row)}));
    const earliestEnd = results.reduce((end, result) => result.period.end < end ? result.period.end : end, results[0].period.end);
    // A performance starting after any other possible finish cannot have been first.
    return results.filter(result => result.period.start <= earliestEnd);
  }

  function quantile(sorted, fraction) {
    const position = fraction * (sorted.length - 1);
    const lower = Math.floor(position);
    return sorted[lower] + (position - lower) * (sorted[Math.ceil(position)] - sorted[lower]);
  }

  function niceStep(target) {
    const unit = 10 ** Math.floor(Math.log10(target));
    return [1, 2, 2.5, 5, 10].reduce((best, current) =>
      Math.abs(current * unit - target) < Math.abs(best * unit - target) ? current : best, 1) * unit;
  }

  function histogramLayout(values, isGL) {
    let min = Infinity;
    let max = -Infinity;
    let largestSample = 0;
    for (const sample of values) {
      if (!sample.length) continue;
      min = Math.min(min, sample[0]);
      max = Math.max(max, sample[sample.length - 1]);
      largestSample = Math.max(largestSample, sample.length);
    }
    if (!largestSample) return null;
    const span = max - min;
    const target = isGL ? Math.min(40, Math.max(34, Math.ceil(2.5 * Math.sqrt(largestSample))))
      : largestSample < 15 ? 18 : largestSample < 60 ? 28 : 32;
    const minimumWidth = isGL ? 0.1 : 0.5;
    const width = span ? Math.max(minimumWidth, niceStep(span / target)) : (isGL ? 1 : 2.5);
    let first = Math.floor(min / width) * width;
    let last = Math.ceil(max / width) * width;
    if (min === max) {
      first = min - width / 2;
      last = min + width / 2;
    }
    const bins = Math.max(1, Math.round((last - first) / width));
    const margin = span ? Math.max(width * .2, .05 * span) : width;
    return {first, width, bins, xmin: Math.max(0, Math.min(first, min - margin)),
      xmax: Math.max(last, max + margin)};
  }

  function refinedBandwidth(sorted, binWidth, baseline, upper) {
    const n = sorted.length;
    const lower = binWidth / 2;
    if (lower >= baseline || lower >= upper) return baseline;
    const frequency = new Map();
    for (const value of sorted) frequency.set(value, (frequency.get(value) || 0) + 1);
    const levels = [...frequency];
    const pairs = new Map();
    function add(distance, count) {
      pairs.set(distance, (pairs.get(distance) || 0) + count);
    }
    for (let i = 0; i < levels.length; i++) {
      const [x, count] = levels[i];
      if (count > 1) add(0, count * (count - 1) / 2);
      for (let j = 0; j < i; j++) add((x - levels[j][0]) ** 2, count * levels[j][1]);
    }
    const distances = [...pairs.keys()], occurrences = [...pairs.values()];
    function risk(h) {
      let integrated = n, leaveOneOut = 0;
      for (let i = 0; i < distances.length; i++) {
        const count = occurrences[i];
        const kernel = Math.exp(-distances[i] / (4 * h * h));
        integrated += 2 * count * kernel;
        leaveOneOut += 2 * count * kernel * kernel;
      }
      return integrated / (n * n * h * Math.sqrt(4 * Math.PI)) -
        2 * leaveOneOut / (n * (n - 1) * h * sqrtTwoPi);
    }
    // Use a narrower fit only when the cross-validation risk improves by at least 5%.
    const steps = 80;
    const candidates = Array.from({length: steps + 1}, (_, i) => lower * (upper / lower) ** (i / steps));
    const risks = candidates.map(risk);
    const index = risks.indexOf(Math.min(...risks));
    if (!index || index === steps) return baseline;
    let lo = candidates[index - 1], hi = candidates[index + 1];
    for (let step = 0; step < 18; step++) {
      const a = (2 * lo + hi) / 3, b = (lo + 2 * hi) / 3;
      if (risk(a) < risk(b)) hi = b;
      else lo = a;
    }
    const candidate = (lo + hi) / 2, old = risk(baseline);
    return candidate < baseline && (old - risk(candidate)) / Math.max(Math.abs(old), 1e-12) >= .05
      ? candidate : baseline;
  }

  function kernelBandwidth(sorted, binWidth, isGL, refine) {
    if (sorted.length < 3 || sorted[0] === sorted[sorted.length - 1]) return null;
    const n = sorted.length;
    const mean = sorted.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(sorted.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1));
    const iqr = quantile(sorted, .75) - quantile(sorted, .25);
    const scale = iqr > 0 ? Math.min(sd, iqr / 1.349) : sd;
    const h = .9 * scale * n ** (-.2);
    if (refine && n >= 20) return refinedBandwidth(sorted, binWidth, h, 2 * sd * n ** (-.2));
    return !isGL && n < 15 ? Math.min(h, binWidth) : h;
  }

  function seriesEstimate(values, layout, isGL, refine) {
    const n = values.length;
    const counts = Array(layout.bins).fill(0);
    for (const value of values) {
      const bin = Math.floor((value - layout.first) / layout.width);
      counts[Math.min(counts.length - 1, Math.max(0, bin))]++;
    }
    const bars = counts.map(count => count / (n * layout.width));
    const h = kernelBandwidth(values, layout.width, isGL, refine);
    const curve = [];
    let peak = null;
    if (h) {
      const weights = new Map();
      for (const value of values) weights.set(value, (weights.get(value) || 0) + 1);
      const observations = [...weights.keys()], occurrences = [...weights.values()];
      const density = x => {
        let sum = 0;
        for (let i = 0; i < observations.length; i++) {
          const z = (observations[i] - x) / h;
          sum += occurrences[i] * Math.exp(-.5 * z * z);
        }
        return sum / (n * h * sqrtTwoPi);
      };
      // Include the observations so even a narrow concentration appears on a wide axis.
      const grid = new Set(weights.keys());
      const resolution = 500;
      for (let i = 0; i <= resolution; i++) {
        grid.add(layout.xmin + i * (layout.xmax - layout.xmin) / resolution);
      }
      for (const x of [...grid].sort((a, b) => a - b)) {
        const point = [x, density(x)];
        curve.push(point);
        if (!peak || point[1] > peak[1]) peak = point;
      }
    }
    return {counts, bars, curve, peak, h, median: quantile(values, .5)};
  }

  function distribution(samples, layout, isGL, refine) {
    // Key the fit by its inputs so an updated score or a different comparison series invalidates it.
    const key = JSON.stringify([isGL, !!refine, ...samples.map(s => s.values)]);
    let model = distributionCache.get(key);
    if (model) distributionCache.delete(key);
    else model = {estimates: samples.map(s => seriesEstimate(s.values, layout, isGL, refine))};
    distributionCache.set(key, model);
    if (distributionCache.size > 64) distributionCache.delete(distributionCache.keys().next().value);
    return model;
  }

  function chartViewport() {
    const plots = new Map(), near = new Set();
    const margin = 320;
    let timer = 0;
    function visibility(host, visible) {
      if (visible) {
        near.add(host);
        plots.get(host)?.();
      } else near.delete(host);
    }
    function checkBounds() {
      timer = 0;
      const bounds = [...plots.keys()].map(host => [host, host.getBoundingClientRect()]);
      for (const [host, rect] of bounds) visibility(host,
        rect.width > 0 && rect.bottom >= -margin && rect.top <= innerHeight + margin);
    }
    function scheduleCheck() { if (!timer) timer = setTimeout(checkBounds, 16); }
    const intersections = typeof IntersectionObserver === 'function' && new IntersectionObserver(entries => {
      for (const entry of entries) visibility(entry.target, entry.isIntersecting);
    }, {rootMargin: margin + 'px 0px'});
    const sizes = typeof ResizeObserver === 'function' && new ResizeObserver(entries => {
      for (const entry of entries) if (near.has(entry.target)) plots.get(entry.target)?.();
    });
    if (!intersections) window.addEventListener('scroll', scheduleCheck, {passive: true});
    if (!intersections || !sizes) window.addEventListener('resize', scheduleCheck);
    function printAll() { for (const draw of plots.values()) draw(); }
    window.addEventListener('beforeprint', printAll);
    return {
      set(host, draw) {
        plots.set(host, draw);
        if (intersections) intersections.observe(host);
        else scheduleCheck();
        if (sizes) sizes.observe(host);
        if (near.has(host)) draw();
      },
      dispose() {
        if (intersections) intersections.disconnect();
        if (sizes) sizes.disconnect();
        if (timer) clearTimeout(timer);
        window.removeEventListener('scroll', scheduleCheck);
        window.removeEventListener('resize', scheduleCheck);
        window.removeEventListener('beforeprint', printAll);
        plots.clear();
        near.clear();
      }
    };
  }

  function enableInspection(figure, svg, options) {
    const {width, height, left, right, top, bottom, layout, contextTitle} = options;
    const target = element('div', 'rd-probe-target');
    target.tabIndex = 0;
    target.setAttribute('role', 'slider');
    target.setAttribute('aria-label', contextTitle);
    target.setAttribute('aria-valuemin', layout.xmin);
    target.setAttribute('aria-valuemax', layout.xmax);
    target.setAttribute('aria-valuenow', layout.xmin);
    Object.assign(target.style, {left: 100 * left / width + '%', top: 100 * top / height + '%',
      width: 100 * (right - left) / width + '%', height: 100 * (bottom - top) / height + '%'});
    figure.replaceChildren(svg, target);
    let probe, loading = false, lastInput, touch, holdTimer, frame = 0, latestX;
    function clear() {
      clearTimeout(holdTimer);
      cancelAnimationFrame(frame);
      frame = 0;
      touch = lastInput = null;
      probe?.hide();
    }
    function inspect(input) {
      lastInput = input;
      if (probe) { probe.show(input); return; }
      if (loading) return;
      loading = true;
      const outside = event => { if (!target.contains(event.target)) clear(); };
      document.addEventListener('pointerdown', outside, true);
      window.addEventListener('hashchange', clear);
      window.IPFcnData.chartProbe().then(() => {
        if (!lastInput || !target.isConnected || !target.getClientRects().length) return;
        probe = window.IPFcnChartProbe(figure, svg, target, options);
        probe.show(lastInput);
      }).catch(() => {}).finally(() => {
        loading = false;
        document.removeEventListener('pointerdown', outside, true);
        window.removeEventListener('hashchange', clear);
      });
    }
    function moveTo(x) {
      latestX = x;
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        inspect({x: latestX});
      });
    }
    function startTouch(x, y) {
      clearTimeout(holdTimer);
      touch = {x, y, inspecting: false};
      holdTimer = setTimeout(() => {
        if (!touch || !target.isConnected || !target.getClientRects().length) return;
        touch.inspecting = true;
        inspect({x: touch.x});
      }, 180);
    }
    function moveTouch(x, y) {
      if (!touch) return false;
      if (!touch.inspecting) {
        const dx = Math.abs(x - touch.x), dy = Math.abs(y - touch.y);
        if (dy >= 12 && dy > 1.65 * dx) { clear(); return false; }
        if (dx < 4) return false;
        touch.inspecting = true;
        clearTimeout(holdTimer);
      }
      moveTo(x);
      return true;
    }
    function endTouch(x) {
      if (!touch) return;
      clearTimeout(holdTimer);
      cancelAnimationFrame(frame);
      frame = 0;
      touch = null;
      inspect({x});
    }

    // A native touch sequence keeps its original target even when the finger leaves the plot.
    // Own horizontal motion from its first move, while letting vertical scrolling and pinch zoom through.
    let nativeId = null;
    target.addEventListener('touchstart', event => {
      if (event.touches.length !== 1) { clear(); return; }
      const finger = event.changedTouches[0];
      nativeId = finger.identifier;
      if (!touch) startTouch(finger.clientX, finger.clientY);
    }, {passive: true});
    target.addEventListener('touchmove', event => {
      const finger = event.touches[0];
      if (event.touches.length !== 1 || finger.identifier !== nativeId) { clear(); return; }
      if (moveTouch(finger.clientX, finger.clientY) && event.cancelable) event.preventDefault();
    }, {passive: false});
    target.addEventListener('touchend', event => {
      const finger = Array.from(event.changedTouches).find(t => t.identifier === nativeId);
      if (finger) { nativeId = null; endTouch(finger.clientX); }
    }, {passive: true});
    target.addEventListener('touchcancel', () => { nativeId = null; clear(); }, {passive: true});
    target.onpointerdown = event => {
      if (!event.isPrimary && event.pointerType === 'touch') { clear(); return; }
      if (event.button !== 0) return;
      if (event.isTrusted && target.setPointerCapture) target.setPointerCapture(event.pointerId);
      if (event.pointerType === 'touch') {
        if (nativeId === null) startTouch(event.clientX, event.clientY);
      } else inspect({x: event.clientX});
    };
    target.onpointermove = event => {
      if (event.isPrimary === false) return;
      if (event.pointerType === 'touch') {
        if (nativeId === null) moveTouch(event.clientX, event.clientY);
      } else moveTo(event.clientX);
    };
    target.onpointerup = event => {
      if (event.pointerType === 'touch' && nativeId === null) endTouch(event.clientX);
    };
    target.onpointerleave = event => {
      if (event.pointerType !== 'touch' && !target.hasPointerCapture?.(event.pointerId)) clear();
    };
    target.onpointercancel = event => { if (event.pointerType !== 'touch' || nativeId === null) clear(); };
    target.onblur = () => { if (!touch) clear(); };
    target.onkeydown = event => {
      if (event.key === 'Escape') { clear(); return; }
      if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','Enter',' '].includes(event.key)) return;
      event.preventDefault();
      inspect({key: event.key});
    };
  }

  function chart(host, samples, {en, isGL, xLabel, median, contextTitle, refineBandwidth, singleMeet, note}) {
    const t = (zh, eng) => en ? eng : zh;
    const header = element('div', isGL ? 'rd-figure-head section-bar' : 'rd-figure-head');
    header.append(element(isGL || singleMeet ? 'h3' : 'h4', 'rd-figure-title', contextTitle));
    host.replaceChildren(header);
    samples = samples.filter(sample => sample.values.length);
    for (const sample of samples) sample.values.sort((a, b) => a - b);
    const layout = histogramLayout(samples.map(sample => sample.values), isGL);
    if (!layout) {
      host.append(element('p', 'rd-empty', t('暂无有效成绩。', 'No results available.')));
      if (note) host.append(element('p', 'rd-chart-note', note));
      return () => {};
    }
    const hasCurve = samples.map(({values}) => values.length >= 3 && values[0] !== values[values.length - 1]);
    const labelNodes = [];
    const legend = element('div', 'rd-legend');
    function seriesLabel(index, value) {
      const sample = samples[index];
      const parts = isGL ? [sample.label] : [];
      parts.push('n = ' + sample.values.length);
      if (value !== undefined) parts.push((median && !isGL ? t('中位数 ', 'Median ') : t('峰值 ', 'Mode ')) +
        value + (isGL ? '' : ' kg'));
      return parts.join(' · ');
    }
    for (const [index, sample] of samples.entries()) {
      const item = element('span', 'rd-series');
      const swatch = element('i', 'rd-swatch rd-' + sample.color);
      swatch.setAttribute('aria-hidden', 'true');
      // Reserve space for the statistic without presenting a provisional numeric result.
      const max = sample.values[sample.values.length - 1];
      const placeholder = median || hasCurve[index] ? '\u2007'.repeat(String(Math.ceil(max)).length + 2) : undefined;
      const label = document.createTextNode(seriesLabel(index, placeholder));
      labelNodes.push(label);
      item.append(swatch, label);
      legend.append(item);
    }
    const figure = element('div', 'rd-plot');
    const foot = element('div', 'rd-chart-foot');
    const hasKDE = hasCurve.some(Boolean);
    const markLegend = element('span', 'rd-marks');
    const histKey = element('span', 'rd-hist-key');
    const kdeKey = element('span', 'rd-kde-key');
    histKey.setAttribute('aria-hidden', 'true');
    kdeKey.setAttribute('aria-hidden', 'true');
    for (const [i, sample] of samples.entries()) {
      histKey.append(element('i', 'rd-' + sample.color));
      if (hasCurve[i]) kdeKey.append(element('i', 'rd-' + sample.color));
    }
    markLegend.append(histKey, document.createTextNode(t('直方图', 'Histogram')));
    if (hasKDE) markLegend.append(kdeKey, document.createTextNode(t('高斯核密度估计', 'Gaussian KDE')));
    foot.append(markLegend, element('span', '', t('组距 ', 'Bin width ') + Number(layout.width.toPrecision(6)) + (isGL ? '' : ' kg')));
    header.append(legend);
    host.append(figure, foot);
    if (hasCurve.includes(false)) {
      host.append(element('p', 'rd-sparse', t('样本不足三人或成绩相同时，仅绘制直方图。',
        'A histogram is shown for samples with fewer than three athletes or no variation.')));
    }
    if (note) host.append(element('p', 'rd-chart-note', note));
    const [minHeight, maxHeight] = singleMeet
      ? (isGL ? [224, 286] : hasKDE ? [196, 246] : [166, 202])
      : (isGL ? [248, 374] : [234, 350]);
    // Keep the same plot footprint while its rows are outside the scroll viewport.
    figure.style.aspectRatio = '1 / 0.36';
    figure.style.minHeight = minHeight + 'px';
    figure.style.maxHeight = maxHeight + 'px';
    const pathFor = (points, px, py) => points.map(([x, y], i) =>
      (i ? 'L' : 'M') + px(x).toFixed(2) + ' ' + py(y).toFixed(2)).join('');
    let previousWidth = 0, model;
    return () => {
      const width = Math.round(figure.getBoundingClientRect().width);
      if (width < 120 || width === previousWidth) return;
      previousWidth = width;
      if (!model) {
        model = distribution(samples, layout, isGL, refineBandwidth);
        for (const [index, estimate] of model.estimates.entries()) {
          const value = median && !isGL ? estimate.median : estimate.peak?.[0];
          labelNodes[index].data = seriesLabel(index, value === undefined ? undefined : Number(value.toFixed(1)));
        }
        figure.removeAttribute('style');
      }
      const {estimates} = model;
      const height = Math.round(Math.min(maxHeight, Math.max(minHeight, width * .36)));
      const viewKey = JSON.stringify([width, height, en, !!median, contextTitle, xLabel,
        ...samples.map(s => [s.gender, s.label, s.color])]);
      const ymax = Math.max(...estimates.map(series => Math.max(...series.bars, series.peak?.[1] || 0))) * 1.12;
      const yStep = niceStep(ymax / 4);
      const labelDigits = String(Number(yStep.toPrecision(7))).length;
      const narrow = width < 470;
      const left = Math.max(narrow ? 48 : 64, labelDigits * (narrow ? 7 : 8) + 27);
      const right = width - (narrow ? 24 : 33);
      const top = narrow ? 13 : 18, bottom = height - (narrow ? 44 : 51);
      const px = value => left + (value - layout.xmin) / (layout.xmax - layout.xmin) * (right - left);
      const py = value => bottom - (value / ymax) * (bottom - top);
      const inspection = {width, height, left, right, top, bottom, layout, samples, estimates, px, py,
        en, isGL, contextTitle};
      if (model.viewKey === viewKey) {
        enableInspection(figure, model.svg.cloneNode(true), inspection);
        return;
      }
      const svg = svgElement('svg', {viewBox: '0 0 ' + width + ' ' + height, role: 'img',
        'data-x-min': layout.xmin, 'data-x-max': layout.xmax, 'data-bin-width': layout.width,
        'aria-label': contextTitle + ' · ' + samples.map(s => s.label + ' n=' + s.values.length).join(', ')});
      svg.append(svgElement('title', {}, contextTitle));
      const ticks = (from, to, target) => {
        const step = niceStep((to - from) / target);
        const result = [];
        for (let i = Math.ceil(from / step - 1e-9); i <= Math.floor(to / step + 1e-9); i++) {
          result.push(Number((i * step).toPrecision(7)));
        }
        return result;
      };
      for (const y of ticks(0, ymax, 4)) {
        if (y) svg.append(svgElement('line', {x1: left, x2: right, y1: py(y), y2: py(y), class: 'rd-gridline'}));
        svg.append(svgElement('text', {x: left - 7, y: py(y) + 4, 'text-anchor': 'end', class: 'rd-tick'}, y));
      }
      const xTickTarget = Math.max(2, Math.min(8, Math.floor((right - left) / (narrow ? 52 : 95))));
      for (const x of ticks(layout.xmin, layout.xmax, xTickTarget)) {
        svg.append(svgElement('text', {x: px(x), y: bottom + 17, 'text-anchor': 'middle', class: 'rd-tick'}, x));
      }
      for (const [i, estimate] of estimates.entries()) {
        const hist = svgElement('g', {class: 'rd-bars rd-' + samples[i].color + (isGL ? ' rd-compared' : ''),
          'data-gender': samples[i].gender, 'data-n': samples[i].values.length});
        estimate.bars.forEach((density, k) => {
          if (!density) return;
          const x = layout.first + k * layout.width;
          const rect = svgElement('rect', {x: px(x), y: py(density),
            width: px(x + layout.width) - px(x), height: bottom - py(density),
            'data-x-left': x, 'data-count': estimate.counts[k]});
          rect.append(svgElement('title', {}, samples[i].label + ' · ' + Number(x.toFixed(2)) + '–' +
            Number((x + layout.width).toFixed(2)) + ': ' + estimate.counts[k]));
          hist.append(rect);
        });
        svg.append(hist);
      }
      for (const [i, estimate] of estimates.entries()) {
        if (!estimate.peak) continue;
        const seriesClass = ' rd-' + samples[i].color;
        const line = pathFor(estimate.curve, px, py);
        svg.append(svgElement('path', {d: line + 'L' + right + ' ' + bottom + 'L' + left + ' ' + bottom + 'Z',
          class: 'rd-fill' + seriesClass}));
        svg.append(svgElement('path', {d: line, class: 'rd-curve' + seriesClass}));
        if (!isGL) {
          const x = px(median ? estimate.median : estimate.peak[0]);
          const y = median ? top + 8 : py(estimate.peak[1]);
          svg.append(svgElement('line', {x1: x, x2: x, y1: y, y2: bottom, class: 'rd-marker'}));
          if (!median) svg.append(svgElement('circle', {cx: x, cy: y, r: 2.5, class: 'rd-point' + seriesClass}));
        }
      }
      svg.append(svgElement('path', {d: 'M' + left + ' ' + top + 'V' + bottom + 'H' + right, class: 'rd-axis'}));
      svg.append(svgElement('text', {x: (left + right) / 2, y: height - 7, 'text-anchor': 'middle', class: 'rd-axis-label'}, xLabel));
      const yCenter = (top + bottom) / 2;
      svg.append(svgElement('text', {x: 13, y: yCenter, transform: 'rotate(-90 13 ' + yCenter + ')',
        'text-anchor': 'middle', class: 'rd-axis-label'}, t('概率密度', 'Density')));
      model.viewKey = viewKey;
      model.svg = svg.cloneNode(true);
      enableInspection(figure, svg, inspection);
    };
  }

  function selectField(label, name) {
    const field = element('label', 'rd-field');
    const select = element('select');
    select.name = name;
    field.append(element('span', '', label), select);
    return {field, select};
  }

  function linkOrText(label, href) {
    if (!href) return document.createTextNode(label);
    const link = element('a', '', label);
    link.href = href;
    return link;
  }

  function classDistribution(host, {values, gender, weightClass, metric, en, contextTitle, singleMeet}) {
    const label = names[metric][Number(en)];
    return chart(host, [{label, gender, color: 'blue', values}], {
      en, isGL: false, xLabel: label + ' (kg)', contextTitle, singleMeet, refineBandwidth: metric === 'total',
      median: gender === 'F' && metric === 'total' && ['69', '76', '84'].includes(weightClass)
    });
  }

  function glDistribution(host, rows, en, contextTitle, singleMeet, note) {
    const samples = ['M', 'F'].map(gender => ({
      label: names[gender][Number(en)], gender, color: gender === 'M' ? 'blue' : 'orange',
      values: bestByAthlete(rows.filter(row => !isUnplacedResult(row) && row.gender === gender), 'gl').map(row => row.gl)
    }));
    return chart(host, samples, {en, isGL: true, xLabel: names.gl[Number(en)], contextTitle, singleMeet, note});
  }

  function renderMeet({language, metric, classCharts, glChart}) {
    const en = language === 'en';
    const viewport = chartViewport();
    function panel(host, className, draw) {
      const section = element('section', 'rd-section rd-meet-section ' + className);
      const figure = element('div', 'rd-figure');
      section.append(figure);
      host.replaceChildren(section);
      viewport.set(figure, draw(figure));
      return section;
    }
    for (const {host, gender, weightClass, rows} of classCharts) {
      const lift = names[metric][Number(en)];
      const group = [names[gender][Number(en)], weightClass ? weightClass + ' kg' : ''].filter(Boolean);
      const distribution = en ? lift + ' distribution' : lift + (metric === 'total' ? '分布' : '成绩分布');
      const title = group.concat(distribution).join(' · ');
      const values = rows.filter(row => !isUnplacedResult(row)).map(row => row[metric]).filter(value => Number.isFinite(value) && value > 0);
      const section = panel(host, 'meet-class-distribution', figure =>
        classDistribution(figure, {values, gender, weightClass, metric, en, contextTitle: title, singleMeet: true}));
      Object.assign(section.dataset, {gender, class: weightClass || '', metric});
    }
    const title = en ? 'Meet GL points distribution' : '本场GL系数分布';
    const section = panel(glChart.host, 'meet-gl-distribution', figure => glDistribution(figure, glChart.rows, en, title, true));
    section.dataset.metric = 'gl';

    return viewport.dispose;
  }

  function render(container, options) {
    const {records, discipline, language} = options;
    const en = language === 'en', langIndex = en ? 1 : 0;
    const t = (zh, eng) => en ? eng : zh;
    const title = key => names[key][langIndex];
    let state = preferences.get(container);
    if (!state) {
      state = {gender: 'M', classes: {M: '83', F: '63'}, metric: 'total'};
      preferences.set(container, state);
    }
    state.viewport?.dispose();
    const viewport = chartViewport();
    state.viewport = viewport;
    container.replaceChildren();
    const benchOnly = discipline === 'B';
    const eligible = records.filter(row => !isUnplacedResult(row) && row.rankings_eligible === true && (row.gender === 'M' || row.gender === 'F'));
    const raw = eligible.filter(row => (row.discipline || 'SBD') === (benchOnly ? 'B' : 'SBD'));
    const metrics = benchOnly ? ['bench'] : ['squat', 'bench', 'deadlift', 'total'];
    const groups = {M: new Map(), F: new Map()};
    for (const row of eligible) {
      const wc = groupClass(row);
      if (wc && !groups[row.gender].has(wc)) groups[row.gender].set(wc, []);
    }
    for (const row of raw) {
      const wc = groupClass(row);
      if (!wc) continue;
      groups[row.gender].get(wc).push(row);
    }
    const seed = [options.genderFilter || '', options.classFilter || ''].join('/');
    if (state.seed !== seed || options.applyRankingSelection) {
      const hintedGender = options.genderFilter;
      const hintedClass = options.classFilter;
      if (hintedGender === 'M' || hintedGender === 'F') state.gender = hintedGender;
      if (hintedClass) {
        const matches = ['M', 'F'].filter(g => groups[g].has(groupClass({gender: g, weight_class: hintedClass})));
        if (!hintedGender && matches.length === 1) state.gender = matches[0];
        const wc = groupClass({gender: state.gender, weight_class: hintedClass});
        if (groups[state.gender].has(wc)) state.classes[state.gender] = wc;
      }
      state.seed = seed;
    }

    const section = (zh, english, description, control) => {
      const pane = element('section', 'rd-section');
      const header = element('div', 'rd-header');
      const tools = element('div', 'rd-chart-heading');
      tools.append(element('p', '', description));
      if (control) tools.append(control);
      header.append(element('h3', 'section-bar', t(zh, english)), tools);
      pane.append(header);
      container.append(pane);
      return pane;
    };
    function countsForRecord(row) {
      const federation = row.record_federation ?? options.recordFederations?.[row.meet_id];
      if (row.meet_type === 'domestic') return federation === 'IPFcn' && row.year >= 2020;
      return row.meet_type === 'international' && ['APF', 'IPF'].includes(federation) &&
        ['chn', 'china', '中国'].includes((row.team || '').trim().toLowerCase());
    }
    const recordsPane = section('全国纪录', 'National records', t('取 IPFcn 成立以来收录的国内赛事，以及代表中国参加 APF、IPF 国际赛事的各级别最高成绩。同成绩取最早达成者。', 'Highest archived mark in each class at domestic IPFcn meets since 2020 or for Team China at APF or IPF international meets. Ties go to the first athlete to achieve the mark.'));
    const fields = element('div', 'rd-filters');
    const gender = selectField(t('性别', 'Gender'), 'record-gender');
    const weightClass = selectField(t('体重级别', 'Weight class'), 'record-class');
    for (const g of ['M', 'F']) gender.select.add(new Option(title(g), g));
    gender.select.value = state.gender;
    fields.append(gender.field, weightClass.field);
    const tableWrap = element('div', 'rd-table-wrap');
    recordsPane.append(fields, tableWrap);

    const measure = selectField(t('成绩指标', 'Measure'), 'record-measure');
    if (!benchOnly) {
      for (const key of ['total', 'squat', 'bench', 'deadlift']) measure.select.add(new Option(title(key), key));
      measure.select.value = state.metric;
    }
    const classPane = section('级别成绩分布', 'Weight-class distribution',
      t('每位运动员取该级别、该项目的个人最好成绩。', 'One personal best per athlete for the selected weight class and lift.'),
      benchOnly ? null : measure.field);
    const classChart = element('div', 'rd-figure');
    classPane.append(classChart);
    const glPane = element('section', 'rd-section');
    const glChart = element('div', 'rd-figure');
    glPane.append(glChart);
    container.append(glPane);
    const drawGL = glDistribution(glChart, raw, en, t('GL系数分布', 'GL points distribution'), false,
      t('每位运动员取本项目最高GL系数，男女分别按概率密度绘制。',
        'One best GL score per athlete in this discipline. Densities are normalized separately for men and women.'));
    viewport.set(glChart, drawGL);

    function showClass(refreshTable) {
      const g = gender.select.value;
      const wc = weightClass.select.value;
      const rows = groups[g].get(wc) || [];
      const metric = benchOnly ? 'bench' : measure.select.value;
      if (refreshTable) {
        tableWrap.replaceChildren();
        const table = element('table', 'rd-table');
        const caption = element('caption', '', title(g) + ' · ' + (wc ? wc + ' kg' : '—'));
        const head = element('thead');
        const columnRow = element('tr');
        const headings = [t('项目', 'Lift'), t('成绩', 'Mark'), t('运动员', 'Athlete'), t('赛事', 'Meet')];
        for (const label of headings) {
          const th = element('th', '', label);
          th.scope = 'col';
          columnRow.append(th);
        }
        head.append(columnRow);
        const body = element('tbody');
        const recordRows = rows.filter(countsForRecord);
        for (const key of metrics) {
          const first = firstPerformances(recordRows, key);
          const tr = element('tr');
          Object.assign(tr.dataset, {gender: g, class: wc, metric: key});
          const lift = element('th', '', title(key));
          lift.scope = 'row';
          const mark = element('td', 'rd-mark', first.length ? String(first[0].row[key]) : '—');
          if (first.length) mark.append(element('small', '', ' kg'));
          const person = element('td', 'rd-person');
          const event = element('td', 'rd-event');
          const athletes = new Set(), meets = new Set();
          for (const {row, period} of first) {
            if (!athletes.has(row.athlete_id)) {
              if (athletes.size) person.append(document.createTextNode(t('、', ', ')));
              person.append(linkOrText(options.athleteName?.(row) || row.name, options.athleteHref?.(row)));
              athletes.add(row.athlete_id);
            }
            const meeting = row.meet_id + '/' + period.label;
            if (!meets.has(meeting)) {
              const source = element('div');
              source.append(linkOrText(options.meetName?.(row) || (en ? row.meet_name_en : row.meet_name), options.meetHref?.(row)));
              source.append(element('small', '', period.label));
              event.append(source);
              meets.add(meeting);
            }
          }
          if (!first.length) {
            person.textContent = event.textContent = '—';
          } else if (athletes.size === 1 && meets.size === 1) {
            tr.dataset.recordId = first[0].row.record_id;
          } else {
            tr.dataset.priority = 'unresolved';
            event.append(element('small', 'rd-priority-note', athletes.size === 1
              ? t('首次达成场次待核', 'First meet unconfirmed')
              : t('首次达成顺序待核', 'Order of achievement unconfirmed')));
          }
          tr.append(lift, mark, person, event);
          body.append(tr);
        }
        table.append(caption, head, body);
        tableWrap.append(table);
        if ((g === 'F' && wc === '47') || (g === 'M' && wc === '59')) {
          tableWrap.append(element('p', 'rd-group-note', g === 'F' ? t('含女子43 kg级成绩。', 'Includes the women’s 43 kg class.')
            : t('含男子53 kg级成绩。', 'Includes the men’s 53 kg class.')));
        }
      }
      const classTitle = [title(g), wc ? wc + ' kg' : '', title(metric)].filter(Boolean).join(' · ');
      viewport.set(classChart, classDistribution(classChart, {values: bestByAthlete(rows, metric).map(row => row[metric]),
        gender: g, weightClass: wc, metric, en, contextTitle: classTitle}));
    }

    function changeGender() {
      const g = gender.select.value;
      state.gender = g;
      const classes = [...groups[g].keys()].sort(compareClasses);
      weightClass.select.replaceChildren(...classes.map(wc => new Option(wc + ' kg', wc)));
      if (classes.includes(state.classes[g])) weightClass.select.value = state.classes[g];
      weightClass.select.disabled = !classes.length;
      showClass(true);
    }
    gender.select.addEventListener('change', changeGender);
    weightClass.select.addEventListener('change', () => {
      state.classes[state.gender] = weightClass.select.value;
      showClass(true);
    });
    measure.select.addEventListener('change', () => {
      state.metric = measure.select.value;
      showClass(false);
    });
    changeGender();
  }

  window.IPFcnRecords = {render, renderMeet};
})();
