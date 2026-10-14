/* Offline trajectory ingestion and comparison. All internal distances are m,
 * times s, and speeds m/s. CSV speeds and reported speed errors use km/h. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TrafficData = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LIMITS = Object.freeze({ maxCharacters: 12 * 1024 * 1024, maxRows: 150000,
    maxVehicles: 30, minDuration: 1, maxDuration: 300, maxSampleGap: 2, sampleDt: 0.2 });
  const REQUIRED = ['time_s', 'vehicle_id', 'position_m', 'speed_kmh'];
  const EPS = 1e-8;
  function fail(message) { throw new Error(message); }
  function finite(value, label, row) {
    if (!value.trim() || !Number.isFinite(Number(value))) fail(`${row}행: ${label}에 유한한 숫자가 필요합니다.`);
    return Number(value);
  }

  // RFC 4180 quoting, including escaped quotes and embedded newlines.
  function readRows(text) {
    if (typeof text !== 'string') fail('CSV 텍스트를 입력해 주세요.');
    if (text.length > LIMITS.maxCharacters) fail('CSV는 12 Mi 문자 이하로 나누어 주세요.');
    const rows = [], rowLines = [];
    let row = [], field = '', quoted = false, closed = false, line = 1, startLine = 1;
    const source = text.replace(/^\uFEFF/, '');
    const saveField = () => { row.push(field); field = ''; closed = false; };
    const saveRow = () => {
      saveField();
      if (row.some(v => v.trim() !== '')) { rows.push(row); rowLines.push(startLine); }
      if (rows.length > LIMITS.maxRows + 1) fail(`CSV는 ${LIMITS.maxRows.toLocaleString()}개 데이터 행 이하로 나누어 주세요.`);
      row = [];
    };
    for (let i = 0; i < source.length; i++) {
      const ch = source[i];
      if (quoted) {
        if (ch === '"') {
          if (source[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; }
        } else { field += ch; if (ch === '\n') line++; }
      } else if (ch === '"') {
        if (field.length || closed) fail(`${line}행: CSV 따옴표 형식이 올바르지 않습니다.`);
        quoted = true;
      } else if (ch === ',') saveField();
      else if (ch === '\n' || ch === '\r') {
        saveRow();
        if (ch === '\r' && source[i + 1] === '\n') i++;
        line++; startLine = line;
      } else if (closed && !/\s/.test(ch)) fail(`${line}행: 닫는 따옴표 다음에는 쉼표 또는 줄바꿈이 필요합니다.`);
      else if (!closed) field += ch;
      if (field.length > 1024) fail(`${line}행: 한 필드의 길이는 1,024자 이하여야 합니다.`);
    }
    if (quoted) fail('CSV의 닫는 따옴표가 누락되었습니다.');
    if (field.length || row.length || closed) saveRow();
    return { rows, rowLines };
  }

  function interpolate(series, t) {
    if (t <= series[0].t + EPS) return series[0];
    const last = series.length - 1;
    if (t >= series[last].t - EPS) return series[last];
    let lo = 0, hi = last;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (series[mid].t <= t) lo = mid; else hi = mid; }
    const f = (t - series[lo].t) / (series[hi].t - series[lo].t);
    return { t, x: series[lo].x + f * (series[hi].x - series[lo].x), v: series[lo].v + f * (series[hi].v - series[lo].v) };
  }

  function ranges(frames, count) {
    const min = Array(count).fill(Infinity), max = Array(count).fill(-Infinity);
    let minGap = Infinity;
    for (const f of frames) for (let i = 0; i < count; i++) {
      min[i] = Math.min(min[i], f.v[i]); max[i] = Math.max(max[i], f.v[i]);
      if (i > 0 && Number.isFinite(f.gap[i])) minGap = Math.min(minGap, f.gap[i]);
    }
    // Match TrafficModel metric units (m/s); only RMSE uses km/h.
    const speedRangeByCar = min.map((m, i) => max[i] - m);
    return { speedRangeByCar, minGap, leadRange: speedRangeByCar[0], tailRange: speedRangeByCar[count - 1],
      amplification: speedRangeByCar[0] > 1e-6 ? speedRangeByCar[count - 1] / speedRangeByCar[0] : null };
  }

  function parseCSV(text, options) {
    options = options || {};
    const vehicleLength = options.vehicleLength === undefined ? 4.5 : Number(options.vehicleLength);
    const sampleDt = options.sampleDt === undefined ? LIMITS.sampleDt : Number(options.sampleDt);
    if (!(vehicleLength >= 1 && vehicleLength <= 15)) fail('차량 길이는 1~15 m여야 합니다.');
    if (!(sampleDt >= 0.05 && sampleDt <= 1)) fail('분석 표본 간격은 0.05~1초여야 합니다.');
    const { rows, rowLines } = readRows(text);
    if (rows.length < 2) fail('열 이름과 관측 데이터가 있는 CSV가 필요합니다.');
    const header = rows[0].map(v => v.trim());
    if (new Set(header).size !== header.length) fail('CSV에 중복된 열 이름이 있습니다.');
    const missing = REQUIRED.filter(h => !header.includes(h));
    if (missing.length) fail(`필수 열이 없습니다: ${missing.join(', ')}. 속도 단위는 km/h입니다.`);
    const col = Object.fromEntries(REQUIRED.map(h => [h, header.indexOf(h)]));
    const byId = new Map();
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i], line = rowLines[i];
      if (row.length !== header.length) fail(`${line}행: 데이터 열 수(${row.length})가 헤더(${header.length})와 다릅니다.`);
      const id = row[col.vehicle_id].trim();
      if (!id || id.length > 80 || /[\r\n\x00-\x1f]/.test(id)) fail(`${line}행: vehicle_id는 제어문자 없는 1~80자 식별자여야 합니다.`);
      const t = finite(row[col.time_s], 'time_s', line);
      const x = finite(row[col.position_m], 'position_m', line);
      const speed = finite(row[col.speed_kmh], 'speed_kmh', line);
      if (Math.abs(t) > 1e12 || Math.abs(x) > 1e9) fail(`${line}행: 시간 또는 위치 값이 지원 범위를 벗어났습니다.`);
      if (speed < 0 || speed > 300) fail(`${line}행: speed_kmh는 0~300 km/h여야 합니다.`);
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push({ t, x, v: speed / 3.6 });
      if (byId.size > LIMITS.maxVehicles) fail(`한 번에 ${LIMITS.maxVehicles}대 이하의 차량을 분석할 수 있습니다.`);
    }
    if (byId.size < 2) fail('선두와 후속 차량을 비교하려면 최소 2대가 필요합니다.');
    let maxSampleGap = 0, minSampleGap = Infinity, consistencySum = 0, consistencyN = 0;
    for (const [id, samples] of byId) {
      samples.sort((a, b) => a.t - b.t);
      if (samples.length < 3) fail(`차량 ${id}: 최소 3개 시점의 관측이 필요합니다.`);
      for (let j = 1; j < samples.length; j++) {
        const prev = samples[j - 1], curr = samples[j], gap = curr.t - prev.t;
        if (gap <= EPS) fail(`차량 ${id}: ${curr.t}초에 중복되거나 구분 불가능한 관측 시각이 있습니다.`);
        if (curr.x < prev.x - EPS) fail(`차량 ${id}: position_m가 감소합니다. 진행 방향으로 증가하는 종방향 좌표를 사용해 주세요.`);
      }
    }
    const commonStart = Math.max(...Array.from(byId.values(), s => s[0].t));
    const commonEnd = Math.min(...Array.from(byId.values(), s => s[s.length - 1].t));
    const duration = commonEnd - commonStart;
    const minDuration = Math.max(LIMITS.minDuration, 2 * sampleDt);
    if (duration < minDuration - EPS) fail(`모든 차량의 공통 관측 구간이 최소 ${minDuration.toFixed(2)}초 이상이어야 합니다.`);
    if (duration > LIMITS.maxDuration + EPS) fail(`공통 관측 구간은 ${LIMITS.maxDuration}초 이하로 나누어 주세요.`);
    const warnings = [], knots = new Set([commonStart, commonEnd]);
    for (const [id, samples] of byId) for (let j = 1; j < samples.length; j++) {
      const prev = samples[j - 1], curr = samples[j];
      if (curr.t <= commonStart + EPS || prev.t >= commonEnd - EPS) continue;
      const gap = curr.t - prev.t;
      maxSampleGap = Math.max(maxSampleGap, gap); minSampleGap = Math.min(minSampleGap, gap);
      if (gap > LIMITS.maxSampleGap + EPS) fail(`차량 ${id}: 공통 구간에 ${gap.toFixed(2)}초의 관측 누락이 있습니다. 보간은 최대 ${LIMITS.maxSampleGap}초 간격까지 허용합니다.`);
      consistencySum += Math.abs((curr.x - prev.x) / gap - (curr.v + prev.v) / 2);
      consistencyN++;
      if (curr.t > commonStart && curr.t < commonEnd) knots.add(curr.t);
    }
    const ids = Array.from(byId.keys()).sort((a, b) => interpolate(byId.get(b), commonStart).x - interpolate(byId.get(a), commonStart).x);
    const series = ids.map(id => byId.get(id));
    // A difference of piecewise-linear trajectories reaches its minimum at a
    // source knot. Check every knot, not only the coarser display sample grid.
    for (const t of Array.from(knots).sort((a, b) => a - b)) {
      let aheadX = interpolate(series[0], t).x;
      for (let i = 1; i < series.length; i++) {
        const x = interpolate(series[i], t).x;
        if (aheadX - x - vehicleLength <= EPS) fail(`${t.toFixed(3)}초: 차량 ${ids[i - 1]} / ${ids[i]}의 순서가 바뀌거나 차량이 겹칩니다. 동일 차로 궤적과 차량 길이(${vehicleLength} m)를 확인해 주세요.`);
        aheadX = x;
      }
    }
    const startOffset = interpolate(series[0], commonStart).x;
    const times = [];
    for (let i = 0; i * sampleDt <= duration + EPS; i++) times.push(Math.min(duration, i * sampleDt));
    if (duration - times[times.length - 1] > EPS) times.push(duration);
    const frames = times.map(t => {
      const values = series.map(s => interpolate(s, commonStart + t));
      const x = values.map(s => s.x - startOffset), v = values.map(s => s.v);
      return { t, x, v, a: Array(ids.length).fill(0), gap: x.map((pos, i) => i ? x[i - 1] - pos - vehicleLength : null) };
    });
    for (let k = 0; k < frames.length; k++) {
      const lo = Math.max(0, k - 1), hi = Math.min(frames.length - 1, k + 1);
      frames[k].a = frames[k].v.map((_, i) => (frames[hi].v[i] - frames[lo].v[i]) / (frames[hi].t - frames[lo].t));
    }
    const firstSource = Math.min(...series.map(s => s[0].t)), lastSource = Math.max(...series.map(s => s[s.length - 1].t));
    if (commonStart - firstSource > EPS || lastSource - commonEnd > EPS) warnings.push(`차량별 관측 범위가 달라 공통 구간 ${commonStart.toFixed(2)}~${commonEnd.toFixed(2)}초만 사용합니다.`);
    if (maxSampleGap > 1 + EPS) warnings.push(`최대 관측 간격이 ${maxSampleGap.toFixed(2)}초입니다. 선형 보간으로 짧은 제동 변화가 완만해질 수 있습니다.`);
    const meanConsistencyErrorKmh = consistencyN ? 3.6 * consistencySum / consistencyN : 0;
    if (meanConsistencyErrorKmh > 5) warnings.push(`위치 차분 속도와 입력 속도의 평균 차이가 ${meanConsistencyErrorKmh.toFixed(1)} km/h입니다. 좌표·단위·동기화를 확인해 주세요.`);
    const ignoredColumns = header.filter(h => !REQUIRED.includes(h));
    if (ignoredColumns.length) warnings.push(`추가 열 ${ignoredColumns.join(', ')}은 분석에 사용하지 않습니다.`);
    return {
      ids, count: ids.length, duration, frames, absoluteStartTime: commonStart, vehicleLength, sampleDt,
      observed: { times, leaderX: frames.map(f => f.x[0]), leaderV: frames.map(f => f.v[0]),
        initialX: frames[0].x.slice(), initialV: frames[0].v.slice() },
      metrics: ranges(frames, ids.length), warnings,
      summary: { rowCount: rows.length - 1, vehicleCount: ids.length, sampleCount: frames.length,
        commonStart, commonEnd, maxSampleGap, minSampleGap, meanConsistencyErrorKmh, ignoredColumns,
        interpolation: 'linear', positionReference: 'front bumper, increasing in travel direction',
        assumption: 'one lane, fixed vehicle order, uniform vehicle length' }
    };
  }

  function frameAt(frames, t) {
    if (t < frames[0].t - EPS || t > frames[frames.length - 1].t + EPS) return null;
    if (t <= frames[0].t + EPS) return { ...frames[0] };
    if (t >= frames[frames.length - 1].t - EPS) return { ...frames[frames.length - 1] };
    let lo = 0, hi = frames.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (frames[mid].t <= t) lo = mid; else hi = mid; }
    const a = frames[lo], b = frames[hi], q = (t - a.t) / (b.t - a.t);
    return { t, x: a.x.map((v, i) => v + q * (b.x[i] - v)), v: a.v.map((v, i) => v + q * (b.v[i] - v)) };
  }

  function compare(result, dataset) {
    if (!result || !Array.isArray(result.frames) || !result.frames.length) fail('비교할 시뮬레이션 프레임이 없습니다.');
    if (!dataset || !Array.isArray(dataset.frames) || !dataset.frames.length) fail('비교할 관측 데이터가 없습니다.');
    const count = dataset.ids.length;
    if (result.frames[0].v.length !== count) fail('시뮬레이션과 관측의 차량 수가 다릅니다.');
    const length = result.config && Number.isFinite(result.config.vehicleLength) ? result.config.vehicleLength : dataset.vehicleLength;
    const perCar = dataset.ids.slice(1).map((id, i) => ({ id, index: i + 1, samples: 0, speedSum: 0, gapSum: 0 }));
    const simFrames = [], obsFrames = [];
    for (const measured of dataset.frames) {
      const predicted = frameAt(result.frames, measured.t);
      if (!predicted) continue;
      predicted.gap = predicted.x.map((x, i) => i ? predicted.x[i - 1] - x - length : null);
      const observedGap = measured.x.map((x, i) => i ? measured.x[i - 1] - x - length : null);
      for (let i = 1; i < count; i++) {
        const dv = (predicted.v[i] - measured.v[i]) * 3.6;
        const dg = predicted.gap[i] - observedGap[i];
        if (!Number.isFinite(dv) || !Number.isFinite(dg)) fail('비교 중 유한하지 않은 위치 또는 속도가 발견되었습니다.');
        perCar[i - 1].speedSum += dv * dv; perCar[i - 1].gapSum += dg * dg; perCar[i - 1].samples++;
      }
      simFrames.push(predicted); obsFrames.push({ ...measured, gap: observedGap });
    }
    if (!simFrames.length) fail('시뮬레이션과 관측에 겹치는 시각이 없습니다.');
    const samples = perCar.reduce((sum, p) => sum + p.samples, 0);
    const speedRMSE = Math.sqrt(perCar.reduce((sum, p) => sum + p.speedSum, 0) / samples);
    const gapRMSE = Math.sqrt(perCar.reduce((sum, p) => sum + p.gapSum, 0) / samples);
    const comparedDuration = obsFrames[obsFrames.length - 1].t - obsFrames[0].t;
    return { speedRMSE, gapRMSE, samples, frameCount: simFrames.length, comparedDuration,
      coverage: dataset.duration > 0 ? comparedDuration / dataset.duration : 1,
      followersOnly: true, collision: result.collision || null,
      perCar: perCar.map(p => ({ id: p.id, index: p.index, samples: p.samples,
        speedRMSE: Math.sqrt(p.speedSum / p.samples), gapRMSE: Math.sqrt(p.gapSum / p.samples) })),
      observedMetrics: ranges(obsFrames, count), simulatedMetrics: ranges(simFrames, count) };
  }

  function csvField(value) {
    const str = String(value);
    return /[",\r\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
  }
  function resultToCSV(result, ids, options = {}) {
    if (!result || !result.frames || !result.frames.length) fail('내보낼 궤적이 없습니다.');
    const includeDerived = options.includeDerived === true;
    if (includeDerived && result.frames.some(f => !Array.isArray(f.gap) || !Array.isArray(f.a)
      || f.gap.length !== f.v.length || f.a.length !== f.v.length
      || f.a.some(a => !Number.isFinite(a)) || f.gap.slice(1).some(g => !Number.isFinite(g)))) {
      fail('간격과 가속도를 내보내려면 각 시뮬레이션 프레임의 gap, a 배열이 필요합니다.');
    }
    const columns = includeDerived ? REQUIRED.concat(['gap_m', 'acceleration_m_s2']) : REQUIRED;
    const rows = [columns.join(',')];
    for (const f of result.frames) for (let i = 0; i < f.v.length; i++) {
      const id = ids && ids[i] !== undefined ? ids[i] : `V${String(i + 1).padStart(2, '0')}`;
      // Prefix spreadsheet formulas in externally supplied identifiers.
      const safeId = /^[=+\-@\t\r]/.test(String(id)) ? "'" + id : id;
      const fields = [f.t.toFixed(4), csvField(safeId), f.x[i].toFixed(6), (f.v[i] * 3.6).toFixed(6)];
      if (includeDerived) fields.push(i === 0 ? '' : f.gap[i].toFixed(6), f.a[i].toFixed(6));
      rows.push(fields.join(','));
    }
    return rows.join('\r\n') + '\r\n';
  }

  // Deliberately synthetic, analytically defined trajectories for learning the
  // CSV schema. This is not a real-world experiment or an IDM validation set.
  function csvTemplate() {
    const frames = [], omega = 2 * Math.PI / 20;
    for (let k = 0; k <= 100; k++) {
      const t = k * 0.2, x = [], v = [];
      for (let i = 0; i < 3; i++) {
        const delay = i * 1.3, base = 15, amplitude = 2;
        v.push(base + amplitude * Math.sin(omega * (t - delay)));
        x.push(-32 * i + base * t + amplitude * (Math.cos(omega * delay) - Math.cos(omega * (t - delay))) / omega);
      }
      frames.push({ t, x, v });
    }
    return resultToCSV({ frames }, ['SYNTHETIC_LEAD', 'SYNTHETIC_02', 'SYNTHETIC_03']);
  }

  async function calibrate(dataset, config, options) {
    options = options || {}; config = config || {};
    let model = options.model;
    if (!model && typeof globalThis !== 'undefined') model = globalThis.TrafficModel;
    if (!model && typeof require === 'function') model = require('./model.js');
    if (!model || typeof model.run !== 'function') fail('시뮬레이션 모델을 불러올 수 없습니다.');
    const reactionTimes = options.reactionTimes || [0, 0.3, 0.6, 0.9, 1.2];
    const timeHeadways = options.timeHeadways || [0.8, 1.2, 1.35, 1.6, 1.8, 2, 2.4];
    const current = { reactionTime: 0.94, timeHeadway: 1.35, ...model.defaultConfig, ...config };
    // Keep the current setup as the first candidate, including when it lies
    // between grid points. Equal scores preserve the current setup.
    const candidates = [{ reactionTime: current.reactionTime, timeHeadway: current.timeHeadway, source: 'current' }];
    for (const reactionTime of reactionTimes) for (const timeHeadway of timeHeadways) {
      if (!candidates.some(c => c.reactionTime === reactionTime && c.timeHeadway === timeHeadway)) {
        candidates.push({ reactionTime, timeHeadway, source: 'grid' });
      }
    }
    const total = candidates.length;
    if (!reactionTimes.length || !timeHeadways.length || total > 100) fail('현재 설정을 포함한 보정 후보는 1~100개 조합이어야 합니다.');
    const trials = []; let best = null, completed = 0;
    for (const { reactionTime, timeHeadway, source } of candidates) {
      if (options.signal && options.signal.aborted) { const err = new Error('보정을 취소했습니다.'); err.name = 'AbortError'; throw err; }
      const candidate = { ...config, reactionTime, timeHeadway, count: dataset.count,
        duration: dataset.duration, vehicleLength: dataset.vehicleLength, sampleDt: dataset.sampleDt };
      // Ensure custom resampling intervals remain exact multiples of the
      // numerical timestep, preserving or refining the requested resolution.
      const preferredDt = Number.isFinite(candidate.dt) ? candidate.dt : 0.05;
      candidate.dt = dataset.sampleDt / Math.ceil(dataset.sampleDt / preferredDt);
      let trial, result, comparison;
      try {
        result = model.run(candidate, dataset.observed);
        comparison = compare(result, dataset);
        const valid = !result.collision && comparison.coverage >= 1 - 1e-6;
        trial = { reactionTime, timeHeadway, source, valid, speedRMSE: valid ? comparison.speedRMSE : null,
          reason: result.collision ? 'collision' : valid ? null : 'incomplete' };
        if (valid && (!best || comparison.speedRMSE < best.comparison.speedRMSE)) best = { config: result.config || candidate, result, comparison };
      } catch (err) { trial = { reactionTime, timeHeadway, source, valid: false, speedRMSE: null, reason: err.message }; }
      trials.push(trial); completed++;
      if (options.onProgress) options.onProgress({ completed, total, fraction: completed / total, bestRMSE: best ? best.comparison.speedRMSE : null });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (!best) fail('충돌 없이 전체 관측 구간을 재현하는 보정 후보가 없습니다. 초기 조건과 고정 매개변수를 확인해 주세요.');
    return { ...best, trials, baselineRMSE: trials[0].valid ? trials[0].speedRMSE : null,
      method: 'current setup + coarse grid / follower speed RMSE / in-sample',
      warning: '동일 자료에 대한 격자 탐색 적합도입니다. 전역 최적값·인과 추정·독립 검증을 의미하지 않습니다. 나머지 매개변수는 고정되어 있습니다.' };
  }

  return { LIMITS, parseCSV, compare, comparison: compare, csvTemplate, resultToCSV, calibrate };
});
