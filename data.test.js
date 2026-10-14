'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const data = require('./data.js');
const header = 'time_s,vehicle_id,position_m,speed_kmh';
const close = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
function constantCSV(times = [0, 1, 2], ids = ['lead', 'tail']) {
  return [header, ...times.flatMap(t => ids.map((id, i) => `${t},${id},${10 * t - i * 20},36`))].join('\n');
}
function asResult(dataset) {
  return { frames: structuredClone(dataset.frames), config: { vehicleLength: dataset.vehicleLength }, collision: null };
}

test('CSV converts km/h to m/s, sorts front to back, and computes bumper gap', () => {
  const csv = constantCSV().split('\n');
  const parsed = data.parseCSV([csv[0], ...csv.slice(1).reverse()].join('\r\n'));
  assert.deepEqual(parsed.ids, ['lead', 'tail']);
  close(parsed.frames[0].v[1], 10);
  close(parsed.frames[0].gap[1], 15.5);
  close(parsed.frames.at(-1).x[0], 20);
  assert.equal(parsed.observed.times.length, 11);
});

test('BOM, quoted commas, escaped quotes, and an extra column are supported', () => {
  const csv = '\uFEFF' + header + ',note\r\n' + [0, 1, 2].flatMap(t => [
    `${t},"lead,one",${10 * t},36,"line one\nline two"`,
    `${t},"tail""two",${10 * t - 20},36,ok`
  ]).join('\r\n');
  const parsed = data.parseCSV(csv);
  assert.deepEqual(parsed.ids, ['lead,one', 'tail"two']);
  assert.equal(parsed.summary.rowCount, 6);
  assert.ok(parsed.warnings.some(s => s.includes('추가 열')));
});

test('strict required fields reject empties, missing units, non-finite numbers, and duplicate headers', () => {
  assert.throws(() => data.parseCSV(constantCSV().replace('speed_kmh', 'speed')), /필수 열/);
  assert.throws(() => data.parseCSV(constantCSV().replace('0,lead,0,36', '0,lead,,36')), /유한한 숫자/);
  assert.throws(() => data.parseCSV(constantCSV().replace('0,lead,0,36', '0,lead,Infinity,36')), /유한한 숫자/);
  assert.throws(() => data.parseCSV(constantCSV().replace('speed_kmh', 'position_m')), /중복된 열/);
  assert.throws(() => data.parseCSV(constantCSV().replace('0,lead,0,36', '0,lead,0,-1')), /0~300/);
});

test('duplicate timestamps and too few vehicles or observations are rejected', () => {
  assert.throws(() => data.parseCSV(constantCSV() + '\n0,lead,0,36'), /중복/);
  assert.throws(() => data.parseCSV(constantCSV([0, 1, 2], ['lead'])), /최소 2대/);
  assert.throws(() => data.parseCSV(constantCSV([0, 1])), /최소 3개/);
});

test('common overlap is translated to t=0 and includes its non-grid-aligned endpoint', () => {
  const csv = [header,
    '100,lead,1000,36', '101,lead,1010,36', '102.3,lead,1023,36',
    '100.1,tail,981,36', '101.1,tail,991,36', '102.4,tail,1004,36'].join('\n');
  const parsed = data.parseCSV(csv);
  close(parsed.absoluteStartTime, 100.1);
  close(parsed.duration, 2.2);
  close(parsed.frames[0].x[0], 0);
  close(parsed.frames[0].x[1], -20);
  close(parsed.frames.at(-1).t, 2.2);
  assert.ok(parsed.warnings.some(s => s.includes('공통 구간')));
});

test('partial final sampling interval is preserved without extrapolation', () => {
  const parsed = data.parseCSV(constantCSV([0, 1, 2.15]));
  close(parsed.observed.times.at(-1), 2.15);
  close(parsed.frames.at(-1).x[0], 21.5);
  assert.equal(parsed.frames.length, 12);
  assert.ok(parsed.frames.every(f => f.t <= 2.15));
});

test('no common interval and excessive interpolation gaps are rejected', () => {
  const csv = [header, '0,lead,0,36', '1,lead,10,36', '2,lead,20,36',
    '3,tail,10,36', '4,tail,20,36', '5,tail,30,36'].join('\n');
  assert.throws(() => data.parseCSV(csv), /공통 관측 구간/);
  assert.throws(() => data.parseCSV(constantCSV([0, 1, 4])), /관측 누락/);
});

test('irrelevant pre-overlap gaps do not prevent a valid common interval', () => {
  const csv = [header, '-100,lead,-1000,36', '0,lead,0,36', '1,lead,10,36', '2,lead,20,36',
    '0,tail,-20,36', '1,tail,-10,36', '2,tail,0,36'].join('\n');
  const parsed = data.parseCSV(csv);
  close(parsed.duration, 2);
  close(parsed.summary.maxSampleGap, 1);
});

test('crossing or overlap between display samples is detected at original source knots', () => {
  const csv = [header,
    '0,lead,0,36', '0.1,lead,1,36', '0.2,lead,20,36', '1,lead,30,36',
    '0,tail,-10,36', '0.1,tail,0,36', '0.2,tail,1,36', '1,tail,2,36'].join('\n');
  assert.throws(() => data.parseCSV(csv), /겹칩니다/);
});

test('decreasing coordinates and touching vehicles are rejected', () => {
  assert.throws(() => data.parseCSV(constantCSV().replace('1,tail,-10,36', '1,tail,-21,36')), /position_m가 감소/);
  const csv = [header, ...[0, 1, 2].flatMap(t => [`${t},lead,${t * 10},36`, `${t},tail,${t * 10 - 4.5},36`])].join('\n');
  assert.throws(() => data.parseCSV(csv), /겹칩니다/);
});

test('position-derived and recorded speed inconsistency is surfaced', () => {
  const csv = constantCSV().replaceAll(',36', ',3.6');
  assert.ok(data.parseCSV(csv).warnings.some(s => s.includes('위치 차분 속도')));
});

test('comparison reports exact follower-only RMSE and does not score the forced leader', () => {
  const parsed = data.parseCSV(constantCSV());
  const result = asResult(parsed);
  for (const f of result.frames) { f.v[0] += 100; f.v[1] += 1; f.x[1] -= 2; }
  const compared = data.compare(result, parsed);
  close(compared.speedRMSE, 3.6);
  close(compared.gapRMSE, 2);
  assert.equal(compared.samples, parsed.frames.length);
  assert.equal(compared.perCar.length, 1);
  assert.equal(compared.followersOnly, true);
  close(compared.coverage, 1);
});

test('comparison only scores overlapping times and interpolates model samples', () => {
  const parsed = data.parseCSV(constantCSV());
  const result = asResult(parsed);
  result.frames = [result.frames[0], result.frames[5]];
  const compared = data.compare(result, parsed);
  close(compared.speedRMSE, 0);
  close(compared.gapRMSE, 0);
  close(compared.coverage, 0.5);
  assert.equal(compared.frameCount, 6);
});

test('synthetic CSV template is valid and clearly identifies synthetic vehicles', () => {
  const parsed = data.parseCSV(data.csvTemplate());
  assert.equal(parsed.count, 3);
  assert.equal(parsed.duration, 20);
  assert.equal(parsed.summary.rowCount, 303);
  assert.ok(parsed.ids.every(id => id.startsWith('SYNTHETIC')));
  assert.ok(parsed.metrics.minGap > 20);
  assert.ok(!parsed.warnings.some(w => w.includes('위치 차분 속도')));
  close(parsed.metrics.leadRange, 4, 1e-6);
});

test('actual model accepts imported leader and returns a complete comparable interval', () => {
  const model = require('./model.js');
  const parsed = data.parseCSV(data.csvTemplate());
  const result = model.run({ duration: parsed.duration }, parsed.observed);
  const compared = data.compare(result, parsed);
  assert.equal(result.collision, null);
  close(compared.coverage, 1);
  assert.ok(compared.speedRMSE > 0 && compared.speedRMSE < 5);
  close(result.frames[0].v[0], parsed.frames[0].v[0]);
  close(result.frames.at(-1).x[0], parsed.frames.at(-1).x[0]);
});

test('CSV export round-trips SI values and escapes commas in identifiers', () => {
  const parsed = data.parseCSV(constantCSV());
  const exported = data.resultToCSV(asResult(parsed), ['lead,one', 'tail']);
  const roundtrip = data.parseCSV(exported);
  assert.deepEqual(roundtrip.ids, ['lead,one', 'tail']);
  close(data.compare(asResult(roundtrip), parsed).speedRMSE, 0);
});

test('optional derived CSV columns preserve SI gaps and accelerations, with no leader gap', () => {
  const result = require('./model.js').run({ count: 3, duration: 2 });
  const csv = data.resultToCSV(result, undefined, { includeDerived: true });
  const rows = csv.trim().split('\r\n').map(row => row.split(','));
  assert.deepEqual(rows[0], ['time_s', 'vehicle_id', 'position_m', 'speed_kmh', 'gap_m', 'acceleration_m_s2']);
  assert.equal(rows[1][4], '');
  close(Number(rows[2][4]), result.frames[0].gap[1], 1e-6);
  close(Number(rows[2][5]), result.frames[0].a[1], 1e-6);
  assert.equal(data.csvTemplate().split('\r\n')[0], header);
  assert.equal(data.resultToCSV(result).split('\r\n')[0], header);
  const roundtrip = data.parseCSV(csv);
  close(roundtrip.frames[0].gap[1], result.frames[0].gap[1], 1e-6);
  assert.throws(() => data.resultToCSV({ frames: [{ t: 0, x: [0, -10], v: [1, 1] }] }, undefined, { includeDerived: true }), /gap, a/);
});

test('calibration grid minimizes follower speed RMSE and rejects collision candidates', async () => {
  const parsed = data.parseCSV(constantCSV());
  let calls = 0;
  const model = { run(config) {
    calls++;
    const result = asResult(parsed); result.config = config;
    for (const f of result.frames) f.v[1] += Math.abs(config.reactionTime - 0.6);
    if (config.timeHeadway === 0.8) result.collision = { t: 1, follower: 1, leader: 0 };
    return result;
  } };
  const progress = [];
  const fitted = await data.calibrate(parsed, {}, { model, reactionTimes: [0.3, 0.6, 0.9], timeHeadways: [0.8, 1.2], onProgress: p => progress.push(p) });
  assert.equal(calls, 7);
  assert.equal(fitted.config.reactionTime, 0.6);
  assert.equal(fitted.config.timeHeadway, 1.2);
  close(fitted.comparison.speedRMSE, 0);
  assert.equal(fitted.trials.filter(t => !t.valid).length, 3);
  assert.equal(progress.at(-1).fraction, 1);
  assert.ok(fitted.warning.includes('독립 검증'));
});

test('calibration preserves an off-grid current configuration when every grid candidate is worse', async () => {
  const parsed = data.parseCSV(constantCSV());
  const current = { reactionTime: 0.43, timeHeadway: 1.7 };
  const model = { run(config) {
    const result = asResult(parsed); result.config = config;
    for (const f of result.frames) f.v[1] += Math.abs(config.reactionTime - current.reactionTime)
      + Math.abs(config.timeHeadway - current.timeHeadway);
    return result;
  } };
  const fitted = await data.calibrate(parsed, current, { model, reactionTimes: [0.3, 0.6], timeHeadways: [1.35, 1.8] });
  assert.equal(fitted.config.reactionTime, current.reactionTime);
  assert.equal(fitted.config.timeHeadway, current.timeHeadway);
  close(fitted.comparison.speedRMSE, 0);
  close(fitted.baselineRMSE, 0);
  assert.equal(fitted.trials[0].source, 'current');
});

test('calibration honors cancellation and fails explicitly when all candidates collide', async () => {
  const parsed = data.parseCSV(constantCSV());
  const model = { run() { const result = asResult(parsed); result.collision = { t: 0.1 }; return result; } };
  await assert.rejects(data.calibrate(parsed, {}, { model, reactionTimes: [0], timeHeadways: [1] }), /보정 후보가 없습니다/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(data.calibrate(parsed, {}, { model, signal: controller.signal }), { name: 'AbortError' });
});
