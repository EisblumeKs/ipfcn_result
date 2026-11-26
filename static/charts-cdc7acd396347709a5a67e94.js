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
    if (distributionCache.size > 4) distributionCache.delete(distributionCache.keys().next().value);
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

  function renderPlacingStats(pane, data, saved, t) {
    const controls = element('div', 'rd-filters');
    const year = selectField(t('年份', 'Year'), 'placing-year');
    const gender = selectField(t('性别', 'Gender'), 'placing-gender');
    const scope = selectField(t('年龄组别', 'Age division'), 'placing-scope');
    const metric = selectField(t('统计量', 'Statistic'), 'placing-metric');
    for (const [field, key, choices] of [
      [year, 'year', [['all', t('全部年份', 'All years')], ...data.years.map(y => [String(y), String(y)])]],
      [gender, 'gender', [['M', t('男子', 'Men')], ['F', t('女子', 'Women')]]],
      [scope, 'scope', [
        ['open', t('公开组', 'Open')], ['subjunior', t('少年组', 'Sub-Junior')],
        ['junior', t('青年组', 'Junior')], ['masters1', t('大师一组', 'Masters I')],
        ['masters2', t('大师二组', 'Masters II')], ['masters3', t('大师三组', 'Masters III')],
        ['masters4', t('大师四组', 'Masters IV')], ['combined', t('合并年龄组', 'All ages combined')]
      ]],
      [metric, 'metric', [['mean', t('平均值', 'Mean')], ['median', t('中位数', 'Median')]]]
    ]) {
      for (const [value, label] of choices) field.select.add(new Option(label, value));
      field.select.value = choices.some(([value]) => value === saved[key]) ? saved[key] : choices[0][0];
      controls.append(field.field);
    }
    const table = element('table', 'rd-table rd-placing-table');
    const caption = element('caption'), head = element('thead'), titles = element('tr'), body = element('tbody');
    for (const label of [t('体重级别', 'Weight class'), t('前三名', 'Top three'), t('前二名', 'Top two'), t('冠军', 'Winners')]) {
      const th = element('th', '', label);
      th.scope = 'col';
      titles.append(th);
    }
    const status = element('p', 'sr-only');
    status.setAttribute('role', 'status');
    const note = element('p', 'rd-group-note');
    const countNote = element('p', 'rd-group-note', t(
      '每格人数为所选年份内在该体重级别至少一次取得相应名次的选手数，每人只计一次。冠军同时计入前二和前三，亚军也计入前三。',
      'Each cell counts distinct lifters who reached that placing at least once in the selected years and weight class. Winners also count toward the top two and top three. Runners-up also count toward the top three.'));
    countNote.id = 'placing-count-note';
    table.setAttribute('aria-describedby', countNote.id);
    head.append(titles);
    table.append(caption, head, body);
    pane.append(controls, countNote, table, note, status);
    function update(event) {
      Object.assign(saved, {year: year.select.value, gender: gender.select.value,
        scope: scope.select.value, metric: metric.select.value});
      const byClass = data.periods[saved.year]?.[saved.scope]?.[saved.gender];
      const index = saved.metric === 'median' ? 2 : 1;
      const summary = [year, gender, scope, metric].map(f => f.select.selectedOptions[0].textContent).join(' · ');
      caption.textContent = summary;
      const division = scope.select.selectedOptions[0].textContent;
      note.textContent = saved.scope === 'combined'
        ? t('合并年龄组将各年龄组选手按每场比赛的性别和体重级别重新排名。',
          'All ages combined ranks lifters across age divisions by sex and weight class within each meet.')
        : t('仅统计参加' + division + '的选手。兼报其他组别时，只使用该选手在本组的成绩。',
          'Includes lifters entered in the ' + division + ' division. For lifters entered in multiple divisions, only their result in this division counts.');
      const rows = document.createDocumentFragment();
      for (const wc of data.classes[saved.gender]) {
        const row = element('tr');
        const th = element('th', '', wc + ' kg');
        th.scope = 'row';
        row.append(th);
        for (let i = 0; i < 3; i++) {
          const sample = byClass?.[wc]?.[i];
          const count = sample?.[0] || 0;
          const cell = element('td');
          const value = count ? sample[index] : null;
          cell.append(element('span', 'rd-placing-value', value == null ? '—' : value + ' kg'),
            element('small', '', t(count + ' 人', count + (count === 1 ? ' lifter' : ' lifters'))));
          row.append(cell);
        }
        rows.append(row);
      }
      body.replaceChildren(rows);
      if (event) status.textContent = t('已更新：', 'Updated: ') + summary;
    }
    controls.addEventListener('change', update);
    update();
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
    const {analytics, discipline, language} = options;
    const en = language === 'en', langIndex = en ? 1 : 0;
    const t = (zh, eng) => en ? eng : zh;
    const title = key => names[key][langIndex];
    let state = preferences.get(container);
    if (!state) {
      state = {gender: 'M', classes: {M: '83', F: '63'}, metric: 'total', year: '', division: '公开组'};
      preferences.set(container, state);
    }
    state.viewport?.dispose();
    const viewport = chartViewport();
    state.viewport = viewport;
    container.replaceChildren();
    const benchOnly = discipline === 'B';
    const metrics = benchOnly ? ['bench'] : ['squat', 'bench', 'deadlift', 'total'];
    const isYouth = age => age === '少年组' || age === '青年组';
    const availableClasses = (gender, age) => analytics.classes[gender][isYouth(age) ? 'youth' : 'open'];
    const national = analytics.national;
    const world = analytics.world;
    // Only expand the record holders displayed by the current selections.
    function nationalRow(index) {
      const [meetIndex, ...values] = national.results[index];
      const row = Object.fromEntries(national.resultFields.map((field, i) => [field, values[i]]));
      national.meetFields.forEach((field, i) => { row[field] = national.meets[meetIndex][i]; });
      return {row, period: resultPeriod(row)};
    }
    function worldRow([eventIndex, sourceIndex, ...values]) {
      const row = Object.fromEntries(world.fields.map((field, i) => [field, values[i]]));
      world.eventFields.forEach((field, i) => { row[field] = world.events[eventIndex][i]; });
      row.source = world.sources[sourceIndex];
      return row;
    }
    const worldField = key => 2 + world.fields.indexOf(key);
    const worldGender = worldField('gender'), worldAge = worldField('age_group'), worldClass = worldField('class');
    const seed = [options.genderFilter || '', options.classFilter || ''].join('/');
    if (state.seed !== seed || options.applyRankingSelection) {
      const hintedGender = options.genderFilter;
      const hintedClass = options.classFilter;
      if (hintedGender === 'M' || hintedGender === 'F') state.gender = hintedGender;
      if (hintedClass) {
        const matches = ['M', 'F'].filter(g => availableClasses(g, '公开组').includes(groupClass({gender: g, weight_class: hintedClass})));
        if (!hintedGender && matches.length === 1) state.gender = matches[0];
        const wc = groupClass({gender: state.gender, weight_class: hintedClass});
        if (availableClasses(state.gender, '公开组').includes(wc)) state.classes[state.gender] = wc;
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
    const recordsPane = section('全国纪录', 'National records', t('取已收录国内 IPFcn 及中国队 APF、IPF 国际赛事各级别最高成绩；公开组计入所有年龄组，同成绩取最早达成者。', 'Highest archived marks at domestic IPFcn meets since 2020 or for Team China at APF/IPF meets. Open includes all ages; ties go to the first achievement.'));
    recordsPane.dataset.records = 'national';
    const ageGroups = [
      ['公开组', 'Open', 'Open'], ['少年组', 'Sub-Junior', 'Sub-Junior'], ['青年组', 'Junior', 'Junior'],
      ['大师一组', 'Masters I', 'Master 1'], ['大师二组', 'Masters II', 'Master 2'],
      ['大师三组', 'Masters III', 'Master 3'], ['大师四组', 'Masters IV', 'Master 4']
    ];
    const fields = element('div', 'rd-filters');
    const gender = selectField(t('性别', 'Gender'), 'record-gender');
    const weightClass = selectField(t('体重级别', 'Weight class'), 'record-class');
    for (const g of ['M', 'F']) gender.select.add(new Option(title(g), g));
    gender.select.value = state.gender;
    const age = selectField(t('年龄组别', 'Age division'), 'record-division');
    for (const [zh, eng] of ageGroups) age.select.add(new Option(t(zh, eng), zh));
    age.select.value = state.division;
    if (!age.select.value) age.select.value = state.division = '公开组';
    fields.append(gender.field, weightClass.field, age.field);
    const tableWrap = element('div', 'rd-table-wrap');
    recordsPane.append(fields, tableWrap);

    function renderWorldRecords() {
      const pane = section('世界纪录', 'World records',
        t('IPF 经典式世界纪录；公开组同时计入其他年龄组的更高成绩。',
          'IPF classic world records. Higher marks from other age divisions also count toward Open records.'));
      pane.dataset.records = 'world';
      const controls = element('div', 'rd-filters');
      const sex = selectField(t('性别', 'Gender'), 'world-gender');
      const weight = selectField(t('体重级别', 'Weight class'), 'world-class');
      const division = selectField(t('年龄组别', 'Age division'), 'world-division');
      for (const g of ['M', 'F']) sex.select.add(new Option(title(g), g));
      for (const [zh, eng, value] of ageGroups) division.select.add(new Option(t(zh, eng), value));
      const saved = state.world ||= {gender: state.gender, division: 'Open', classes: {M: '83', F: '63'}};
      sex.select.value = saved.gender;
      division.select.value = saved.division;
      controls.append(sex.field, weight.field, division.field);
      const wrap = element('div', 'rd-table-wrap');
      pane.append(controls, wrap);
      function rowsForSelection() {
        return world.entries.filter(row => row[worldGender] === sex.select.value &&
          (division.select.value === 'Open' || row[worldAge] === division.select.value));
      }
      function show() {
        saved.gender = sex.select.value;
        saved.division = division.select.value;
        saved.classes[saved.gender] = weight.select.value;
        const rows = rowsForSelection().filter(row => row[worldClass] === weight.select.value).map(worldRow);
        const table = element('table', 'rd-table');
        table.append(element('caption', '', title(saved.gender) + ' · ' + weight.select.value + ' kg · ' +
          division.select.selectedOptions[0].textContent));
        const head = element('thead'), heading = element('tr'), body = element('tbody');
        for (const label of [t('项目', 'Lift'), t('成绩', 'Mark'), t('运动员', 'Athlete'), t('赛事', 'Meet')]) {
          const th = element('th', '', label); th.scope = 'col'; heading.append(th);
        }
        head.append(heading);
        for (const key of metrics) {
          const candidates = rows.filter(row => row.metric === key);
          const first = [...candidates].sort((a, b) => b.value - a.value || Number(a.standard) - Number(b.standard) ||
            (a.date || '').localeCompare(b.date || ''))[0];
          const tr = element('tr');
          Object.assign(tr.dataset, {gender: saved.gender, class: weight.select.value, metric: key, division: saved.division});
          const lift = element('th', '', title(key)); lift.scope = 'row';
          const mark = element('td', 'rd-mark', first ? String(first.value) : '—');
          if (first) mark.append(element('small', '', ' kg'));
          const person = element('td', 'rd-person', !first ? '—' : first.standard
            ? t('纪录标准', 'World standard') : first.name + ' ' + first.country);
          const event = element('td', 'rd-event');
          if (first && !first.standard) {
            const row = {...first, discipline: first.meet_discipline || first.discipline, meet_name: first.meet_name_zh, meet_name_en: first.meet_name_en};
            event.append(linkOrText(en ? first.meet_name_en : first.meet_name_zh, options.meetHref?.(row)));
            event.append(element('small', '', first.date));
            tr.dataset.source = first.source || '';
          } else event.textContent = '—';
          tr.append(lift, mark, person, event); body.append(tr);
        }
        table.append(head, body); wrap.replaceChildren(table);
      }
      function updateClasses() {
        const small = sex.select.value === 'M' ? '53' : '43';
        const classes = [...new Set(rowsForSelection().map(row => row[worldClass]))]
          .filter(wc => ['Sub-Junior', 'Junior'].includes(division.select.value) || wc !== small).sort(compareClasses);
        weight.select.replaceChildren(...classes.map(wc => new Option(wc + ' kg', wc)));
        if (classes.includes(saved.classes[sex.select.value])) weight.select.value = saved.classes[sex.select.value];
        show();
      }
      sex.select.addEventListener('change', updateClasses);
      division.select.addEventListener('change', updateClasses);
      weight.select.addEventListener('change', show);
      updateClasses();
    }

    renderWorldRecords();
    const year = selectField(t('年份', 'Year'), 'distribution-year');
    const years = Object.keys(analytics.years).map(Number).sort((a, b) => b - a);
    year.select.add(new Option(t('全部年份', 'All years'), ''));
    for (const value of years) year.select.add(new Option(String(value), String(value)));
    if (!years.includes(Number(state.year))) state.year = '';
    year.select.value = state.year;
    const measure = selectField(t('成绩指标', 'Measure'), 'record-measure');
    if (!benchOnly) {
      for (const key of ['total', 'squat', 'bench', 'deadlift']) measure.select.add(new Option(title(key), key));
      measure.select.value = state.metric;
    }
    const distributionControls = element('div', 'rd-distribution-controls');
    distributionControls.append(year.field);
    if (!benchOnly) distributionControls.append(measure.field);
    const classPane = section('级别成绩分布', 'Weight-class distribution',
      t('每位运动员取该级别、该项目的个人最好成绩。', 'One personal best per athlete for the selected weight class and lift.'),
      distributionControls);
    const classChart = element('div', 'rd-figure');
    classPane.append(classChart);

    if (analytics.placingStats) {
      const source = benchOnly
        ? t('统计国内经典卧推单项成绩。', 'Classic bench-only results from domestic meets. ')
        : t('统计国内经典三项总成绩。', 'Totals from domestic classic powerlifting meets. ');
      const rules = t(
        '平均值计入每次达到相应名次的参赛成绩。中位数取每位选手在该级别最佳名次对应的成绩，同名次取最高成绩。结果按最接近的 2.5 kg 显示。',
        'The mean includes every performance that earned the placing shown. For the median, each lifter contributes the score from their best placing in the class, taking the highest score for a repeated placing. Values are rounded to the nearest 2.5 kg.');
      const pane = section('级别名次成绩统计', benchOnly ? 'Podium bench press results by weight class' : 'Podium totals by weight class', source + rules);
      pane.classList.add('rd-placing');
      renderPlacingStats(pane, analytics.placingStats, state.placing ||= {}, t);
    }
    const glPane = element('section', 'rd-section');
    const glChart = element('div', 'rd-figure');
    glPane.append(glChart);
    container.append(glPane);
    let samples, yearRequest = 0;
    function showGL() {
      if (!samples) return;
      const label = t('GL系数分布', 'GL points distribution') + (state.year ? ' · ' + state.year : '');
      const series = ['M', 'F'].map(gender => ({
        label: title(gender), gender, color: gender === 'M' ? 'blue' : 'orange', values: samples.gl[gender] || []
      }));
      glPane.dataset.year = state.year;
      viewport.set(glChart, chart(glChart, series, {en, isGL: true, xLabel: title('gl'), contextTitle: label,
        note: t('每位运动员取所选年份内本项目最高GL系数，男女分别按概率密度绘制。',
          'One best GL score per athlete in this discipline within the selected years. Densities are normalized separately for men and women.')}));
    }

    function showClass(refreshTable) {
      const g = gender.select.value;
      const wc = weightClass.select.value;
      const selectedAge = age.select.value;
      const metric = benchOnly ? 'bench' : measure.select.value;
      if (refreshTable) {
        tableWrap.replaceChildren();
        const table = element('table', 'rd-table');
        const caption = element('caption', '', title(g) + ' · ' + (wc ? wc + ' kg' : '—') + ' · ' + age.select.selectedOptions[0].textContent);
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
        const recordRows = national.groups[[g, wc, selectedAge].join('/')];
        for (const [i, key] of metrics.entries()) {
          const first = (recordRows?.[i] || []).map(nationalRow);
          const tr = element('tr');
          Object.assign(tr.dataset, {gender: g, class: wc, metric: key, division: selectedAge});
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
              const label = linkOrText(options.athleteName?.(row) || row.name, options.athleteHref?.(row));
              person.append(options.withAthleteNote?.(row, label) || label);
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
        if (!['少年组', '青年组'].includes(selectedAge) && ((g === 'F' && wc === '47') || (g === 'M' && wc === '59'))) {
          tableWrap.append(element('p', 'rd-group-note', g === 'F' ? t('含女子43 kg级成绩。', 'Includes the women’s 43 kg class.')
            : t('含男子53 kg级成绩。', 'Includes the men’s 53 kg class.')));
        }
      }
      if (!samples) return;
      const merged = !isYouth(selectedAge) && ((g === 'F' && wc === '47') || (g === 'M' && wc === '59'));
      const sampleKey = [g, wc].join('/') + (merged ? '/merged' : '');
      const values = samples.classes[sampleKey]?.[metrics.indexOf(metric)] || [];
      classPane.dataset.year = state.year;
      const classTitle = [title(g), wc ? wc + ' kg' : '', title(metric), state.year].filter(Boolean).join(' · ');
      viewport.set(classChart, classDistribution(classChart, {values,
        gender: g, weightClass: wc, metric, en, contextTitle: classTitle}));
    }

    function changeGender() {
      const g = gender.select.value;
      state.gender = g;
      const classes = availableClasses(g, age.select.value);
      weightClass.select.replaceChildren(...classes.map(wc => new Option(wc + ' kg', wc)));
      if (classes.includes(state.classes[g])) weightClass.select.value = state.classes[g];
      weightClass.select.disabled = !classes.length;
      showClass(true);
    }
    age.select.addEventListener('change', () => {
      state.division = age.select.value;
      changeGender();
    });
    function changeYear() {
      const request = ++yearRequest;
      const current = () => request === yearRequest && state.viewport === viewport;
      state.year = year.select.value;
      const apply = value => {
        if (!current()) return;
        samples = value;
        classPane.removeAttribute('aria-busy');
        glPane.removeAttribute('aria-busy');
        showClass(false);
        showGL();
      };
      if (!state.year) { apply(analytics.all); return; }
      samples = null;
      classPane.dataset.year = glPane.dataset.year = state.year;
      for (const [pane, host] of [[classPane, classChart], [glPane, glChart]]) {
        pane.setAttribute('aria-busy', 'true');
        viewport.set(host, () => {});
        host.replaceChildren(element('p', 'rd-empty', t('加载中…', 'Loading…')));
      }
      options.loadAnalyticsYear(analytics.years[state.year]).then(apply).catch(() => {
        if (!current()) return;
        for (const [pane, host] of [[classPane, classChart], [glPane, glChart]]) {
          pane.removeAttribute('aria-busy');
          const retry = element('button', '', t('重试', 'Retry'));
          retry.type = 'button';
          retry.addEventListener('click', changeYear, {once: true});
          host.replaceChildren(element('p', 'rd-empty', t('成绩暂时无法加载。', 'Results could not be loaded.')), retry);
        }
      });
    }
    year.select.addEventListener('change', changeYear);
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
    changeYear();
  }

  function release(container) {
    const state = preferences.get(container);
    state?.viewport?.dispose();
    if (state) state.viewport = null;
    container.replaceChildren();
    distributionCache.clear();
  }
  window.IPFcnRecords = {render, renderMeet, release};
})();
