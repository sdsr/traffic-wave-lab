'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('./model');
const close = (actual, expected, tolerance = 1e-7) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected} by more than ${tolerance}`);

test('zero perturbation preserves the analytic IDM equilibrium', () => {
  const result = model.run({ amplitude: 0, duration: 60 });
  assert.equal(result.collision, null);
  assert.equal(result.metrics.amplification, null);
  for (const frame of result.frames) {
    for (let i = 0; i < result.config.count; i++) {
      close(frame.v[i], 65 / 3.6, 1e-8);
      close(frame.x[i], -i * (result.initialGap + result.config.vehicleLength) + 65 / 3.6 * frame.t, 1e-7);
      if (i) close(frame.gap[i], result.initialGap, 1e-7);
    }
  }
});

test('sine and pulse leader positions are integrals of their velocities', () => {
  for (const mode of ['sine', 'pulse']) {
    const config = { ...model.defaultConfig, mode };
    for (const t of [2, 10, 19, 35, 48]) {
      const h = 0.0001;
      close((model.leaderAt(t + h, config).x - model.leaderAt(t - h, config).x) / (2 * h), model.leaderAt(t, config).v, 1e-6);
    }
  }
});

test('sampling starts at zero and includes the exact final time', () => {
  const result = model.run({ duration: 1.03 });
  assert.equal(result.frames[0].t, 0);
  close(result.frames.at(-1).t, 1.03);
  assert.equal(result.frames.length, 7);
  result.frames.slice(0, -1).forEach((frame, i) => close(frame.t, i * 0.2));
});

test('all states stay finite, speeds nonnegative, and positions monotone', () => {
  const result = model.run({ reactionTime: 0.95, timeHeadway: 1.35 });
  assert.equal(result.collision, null);
  for (let k = 0; k < result.frames.length; k++) {
    const frame = result.frames[k];
    for (let i = 0; i < result.config.count; i++) {
      assert.ok(Number.isFinite(frame.x[i]) && Number.isFinite(frame.v[i]) && Number.isFinite(frame.a[i]));
      assert.ok(frame.v[i] >= 0);
      if (i) assert.ok(frame.gap[i] > 0);
      if (k) assert.ok(frame.x[i] >= result.frames[k - 1].x[i] - 1e-8);
    }
  }
});

test('reaction delay does not trigger a follower before delayed leader input arrives', () => {
  const result = model.run({ reactionTime: 0.73, duration: 12, sampleDt: 0.05 });
  for (const frame of result.frames.filter(frame => frame.t < 8.7)) close(frame.v[1], 65 / 3.6, 1e-8);
  assert.ok(result.frames.at(-1).v[1] < 65 / 3.6 - 0.1);
});

test('stable and amplifying presets produce distinct full-run speed ranges', () => {
  const stable = model.run({ reactionTime: 0.6, timeHeadway: 1.8 });
  const wave = model.run({ reactionTime: 0.94, timeHeadway: 1.35 });
  assert.equal(stable.collision, null);
  assert.equal(wave.collision, null);
  assert.ok(stable.metrics.amplification < 0.3);
  assert.ok(wave.metrics.amplification > 1.5);
});

test('halving integration time step converges for delayed dynamics', () => {
  const config = { reactionTime: 0.6, timeHeadway: 1.8, duration: 90 };
  const coarse = model.run({ ...config, dt: 0.05 });
  const fine = model.run({ ...config, dt: 0.025 });
  let maxSpeedError = 0;
  for (let k = 0; k < coarse.frames.length; k++) {
    for (let i = 0; i < coarse.config.count; i++) {
      maxSpeedError = Math.max(maxSpeedError, Math.abs(coarse.frames[k].v[i] - fine.frames[k].v[i]));
    }
  }
  assert.ok(maxSpeedError < 0.003, `time-step speed error ${maxSpeedError} m/s`);
});

test('unsafe reaction settings stop at contact and report the pair', () => {
  const result = model.run({ reactionTime: 1.5, timeHeadway: 0.7, amplitude: 25 });
  assert.ok(result.collision);
  assert.ok(result.collision.t < result.config.duration);
  assert.equal(result.collision.follower, result.collision.leader + 1);
  const last = result.frames.at(-1);
  close(last.t, result.collision.t);
  close(last.gap[result.collision.follower], 0, 1e-7);
  assert.ok(last.gap.slice(1).every(gap => gap >= -1e-7));
});

test('observed leader and measured initial states are used without adjustment', () => {
  const c = { ...model.defaultConfig, count: 3 };
  const gap = model.equilibriumGap(c);
  const speed = c.baselineSpeed / 3.6;
  const observed = {
    times: [0, 1, 2], leaderX: [0, speed, speed * 2], leaderV: [speed, speed, speed],
    initialX: [0, -gap - c.vehicleLength, -2 * (gap + c.vehicleLength)],
    initialV: [speed, speed, speed]
  };
  const result = model.run({}, observed);
  assert.equal(result.config.count, 3);
  assert.equal(result.config.duration, 2);
  assert.equal(result.observed, true);
  assert.deepEqual(result.frames[0].x, observed.initialX);
  assert.deepEqual(result.frames[0].v, observed.initialV);
  for (const frame of result.frames) {
    close(frame.x[0], speed * frame.t);
    close(frame.v[0], speed);
    for (const velocity of frame.v) close(velocity, speed, 1e-7);
  }
});

test('invalid data and invalid configurations fail explicitly', () => {
  assert.throws(() => model.run({ count: 3.2 }), /integer/);
  assert.throws(() => model.run({ reactionTime: NaN }), /reactionTime/);
  assert.throws(() => model.run({ amplitude: 70 }), /amplitude/);
  assert.throws(() => model.run({ sampleDt: 0.13 }), /integer multiple/);
  assert.throws(() => model.run({}, { times: [0, 1], leaderX: [0, 1], leaderV: [1, 1], initialX: [0, -2], initialV: [1, 1] }), /bumper gaps/);
  assert.throws(() => model.run({}, { times: [0, 0], leaderX: [0, 1], leaderV: [1, 1], initialX: [0, -20], initialV: [1, 1] }), /positive time/);
});

test('identical inputs generate identical output', () => {
  assert.deepEqual(model.run({ duration: 20 }), model.run({ duration: 20 }));
});
