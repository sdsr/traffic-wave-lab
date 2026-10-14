/* Traffic Wave Lab — delayed Intelligent Driver Model, SI units internally.
 * IDM: https://mtreiber.de/MicroApplet/IDM.html
 * Delay of ALL stimuli: https://www.mtreiber.de/publications/StabilityIFAC06.pdf
 * Educational homogeneous, one-lane platoon; no lane changes or anticipation.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TrafficModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const defaultConfig = Object.freeze({
    count: 24,
    baselineSpeed: 65,
    amplitude: 10,
    period: 28,
    reactionTime: 0.94,
    timeHeadway: 1.35,
    acceleration: 1.1,
    comfortableBraking: 2,
    desiredSpeed: 100,
    minimumGap: 2,
    vehicleLength: 4.5,
    emergencyBraking: 9,
    mode: 'sine',
    duration: 180,
    disturbanceStart: 8,
    dt: 0.05,
    sampleDt: 0.2
  });

  function configuration(overrides) {
    const c = Object.assign({}, defaultConfig, overrides);
    const bounds = {
      count: [2, 60], baselineSpeed: [1, 150], amplitude: [0, 80],
      period: [4, 120], reactionTime: [0, 3], timeHeadway: [0.3, 4],
      acceleration: [0.1, 5], comfortableBraking: [0.3, 6],
      desiredSpeed: [2, 250], minimumGap: [0.1, 10], vehicleLength: [1, 15],
      emergencyBraking: [1, 12], duration: [1, 300], disturbanceStart: [0, 300],
      dt: [0.005, 0.1], sampleDt: [0.01, 1]
    };
    for (const [key, range] of Object.entries(bounds)) {
      if (!Number.isFinite(c[key]) || c[key] < range[0] || c[key] > range[1]) {
        throw new RangeError(key + ' must be within ' + range.join('..'));
      }
    }
    if (!Number.isInteger(c.count)) throw new RangeError('count must be an integer');
    if (c.desiredSpeed <= c.baselineSpeed) throw new RangeError('desiredSpeed must exceed baselineSpeed');
    if (c.amplitude > c.baselineSpeed) throw new RangeError('amplitude must not exceed baselineSpeed');
    if (!['sine', 'pulse'].includes(c.mode)) throw new RangeError('mode must be sine or pulse');
    const sampleSteps = Math.round(c.sampleDt / c.dt);
    if (sampleSteps < 1 || Math.abs(sampleSteps * c.dt - c.sampleDt) > 1e-9) {
      throw new RangeError('sampleDt must be an integer multiple of dt');
    }
    return c;
  }

  // The prescribed leader trajectory has an analytic position integral.
  // A sine begins by slowing down; a pulse is one smooth raised-cosine dip.
  function leaderAt(t, config) {
    const c = config;
    const base = c.baselineSpeed / 3.6;
    const amp = c.amplitude / 3.6;
    const u = t - c.disturbanceStart;
    const w = 2 * Math.PI / c.period;
    if (u < 0) return { x: base * t, v: base, a: 0 };
    if (c.mode === 'pulse') {
      if (u >= c.period) return { x: base * t - amp * c.period / 2, v: base, a: 0 };
      return {
        x: base * t - amp / 2 * (u - Math.sin(w * u) / w),
        v: base - amp / 2 * (1 - Math.cos(w * u)),
        a: -amp * w / 2 * Math.sin(w * u)
      };
    }
    return {
      x: base * t + amp / w * (Math.cos(w * u) - 1),
      v: base - amp * Math.sin(w * u),
      a: -amp * w * Math.cos(w * u)
    };
  }

  function equilibriumGap(c) {
    const v = c.baselineSpeed / 3.6;
    return (c.minimumGap + v * c.timeHeadway) /
      Math.sqrt(1 - Math.pow(c.baselineSpeed / c.desiredSpeed, 4));
  }

  function idmAcceleration(gap, ownSpeed, closingSpeed, c) {
    if (gap <= 0) return -c.emergencyBraking;
    const desiredGap = c.minimumGap + Math.max(0,
      ownSpeed * c.timeHeadway + ownSpeed * closingSpeed /
      (2 * Math.sqrt(c.acceleration * c.comfortableBraking)));
    const result = c.acceleration * (1 - Math.pow(ownSpeed / (c.desiredSpeed / 3.6), 4)
      - Math.pow(desiredGap / gap, 2));
    // A finite physical braking limit permits collisions under unsafe settings.
    return Math.max(-c.emergencyBraking, Math.min(c.acceleration, result));
  }

  function advance(x, v, a, h) {
    if (a < 0 && v + a * h < 0) return { x: x - v * v / (2 * a), v: 0 };
    return { x: x + v * h + 0.5 * a * h * h, v: Math.max(0, v + a * h) };
  }

  function validateObserved(observed, c) {
    const { times, leaderX, leaderV, initialX, initialV } = observed;
    if (![times, leaderX, leaderV, initialX, initialV].every(Array.isArray)) {
      throw new TypeError('observed requires times, leaderX, leaderV, initialX and initialV arrays');
    }
    if (times.length < 2 || leaderX.length !== times.length || leaderV.length !== times.length) {
      throw new RangeError('observed leader arrays must have matching lengths of at least 2');
    }
    if (initialX.length < 2 || initialX.length > 60 || initialV.length !== initialX.length) {
      throw new RangeError('observed initial arrays must have matching lengths between 2 and 60');
    }
    if (![times, leaderX, leaderV, initialX, initialV].every(arr => arr.every(Number.isFinite))) {
      throw new RangeError('observed values must be finite');
    }
    if (Math.abs(times[0]) > 1e-9 || times[times.length - 1] <= 0) {
      throw new RangeError('observed times must start at 0 and span positive time');
    }
    if (leaderV.some(v => v < 0) || initialV.some(v => v < 0)) {
      throw new RangeError('observed speeds must be nonnegative');
    }
    for (let i = 1; i < times.length; i++) {
      if (times[i] <= times[i - 1]) throw new RangeError('observed times must strictly increase');
      if (leaderX[i] < leaderX[i - 1]) throw new RangeError('observed leader positions must not decrease');
    }
    for (let i = 1; i < initialX.length; i++) {
      if (initialX[i - 1] - initialX[i] <= c.vehicleLength) {
        throw new RangeError('observed initial bumper gaps must be positive');
      }
    }
    if (Math.abs(initialX[0] - leaderX[0]) > 1e-6 || Math.abs(initialV[0] - leaderV[0]) > 1e-6) {
      throw new RangeError('observed initial leader state must match the first leader sample');
    }
  }

  function run(overrides, observed) {
    const c = configuration(overrides);
    if (observed) {
      validateObserved(observed, c);
      c.count = observed.initialX.length;
      c.duration = Math.min(c.duration, observed.times[observed.times.length - 1]);
    }
    const base = c.baselineSpeed / 3.6;
    const equilibrium = equilibriumGap(c);
    const initialX = observed ? observed.initialX.slice() :
      Array.from({ length: c.count }, (_, i) => -i * (equilibrium + c.vehicleLength));
    const initialV = observed ? observed.initialV.slice() : Array(c.count).fill(base);
    const initialGap = observed ? (initialX[0] - initialX[c.count - 1]) / (c.count - 1) - c.vehicleLength : equilibrium;
    const history = [{ t: 0, x: initialX, v: initialV }];
    const frames = [];
    let collision = null;
    let minGap = initialGap;
    const minimumSpeeds = initialV.slice();
    const maximumSpeeds = initialV.slice();
    const sampleSteps = Math.round(c.sampleDt / c.dt);
    let maxBrake = 0;

    // Observed position and speed are independently interpolated, preserving the
    // measured leader. No filtering/calibration is silently applied to source data.
    function prescribedLeader(t) {
      if (!observed) return leaderAt(t, c);
      const { times, leaderX, leaderV } = observed;
      let low = 0, high = times.length - 1;
      while (low + 1 < high) {
        const middle = Math.floor((low + high) / 2);
        if (times[middle] <= t) low = middle;
        else high = middle;
      }
      const width = times[high] - times[low];
      const weight = Math.max(0, Math.min(1, (t - times[low]) / width));
      return {
        x: leaderX[low] + weight * (leaderX[high] - leaderX[low]),
        v: leaderV[low] + weight * (leaderV[high] - leaderV[low]),
        a: (leaderV[high] - leaderV[low]) / width,
        motionV: (leaderX[high] - leaderX[low]) / width
      };
    }

    function delayedState(t, provisional) {
      // The unobserved delay history before t=0 assumes each car kept its initial speed.
      if (t <= 0) return { x: initialX.map((x, i) => x + initialV[i] * t), v: initialV };
      const historyTime = history[history.length - 1].t;
      if (t > historyTime + 1e-10 && provisional) {
        const previous = history[history.length - 1];
        const weight = (t - historyTime) / (provisional.t - historyTime);
        return {
          x: previous.x.map((x, i) => x + weight * (provisional.x[i] - x)),
          v: previous.v.map((v, i) => v + weight * (provisional.v[i] - v))
        };
      }
      const f = t / c.dt;
      const low = Math.min(Math.floor(f), history.length - 1);
      const high = Math.min(low + 1, history.length - 1);
      const interval = history[high].t - history[low].t;
      const weight = interval === 0 ? 0 : Math.max(0, Math.min(1, (t - history[low].t) / interval));
      if (weight < 1e-10 || low === high) return history[low];
      return {
        x: history[low].x.map((value, i) => value + weight * (history[high].x[i] - value)),
        v: history[low].v.map((value, i) => value + weight * (history[high].v[i] - value))
      };
    }

    function accelerations(t, current, provisional) {
      const observed = delayedState(t - c.reactionTime, provisional);
      const a = [prescribedLeader(t).a];
      for (let i = 1; i < c.count; i++) {
        const gap = observed.x[i - 1] - observed.x[i] - c.vehicleLength;
        a.push(idmAcceleration(gap, observed.v[i], observed.v[i] - observed.v[i - 1], c));
        if (current.v[i] === 0 && a[i] < 0) a[i] = 0;
      }
      return a;
    }

    function snapshot(t, state, a) {
      const gaps = state.x.map((x, i) => i === 0 ? null : state.x[i - 1] - x - c.vehicleLength);
      frames.push({ t, x: state.x.slice(), v: state.v.slice(), a: a.slice(), gap: gaps });
    }

    function track(state, a) {
      for (let i = 0; i < c.count; i++) {
        minimumSpeeds[i] = Math.min(minimumSpeeds[i], state.v[i]);
        maximumSpeeds[i] = Math.max(maximumSpeeds[i], state.v[i]);
        if (i > 0) minGap = Math.min(minGap, state.x[i - 1] - state.x[i] - c.vehicleLength);
        maxBrake = Math.max(maxBrake, -a[i]);
      }
    }

    let current = history[0];
    let a = accelerations(0, current);
    track(current, a);
    snapshot(0, current, a);
    const steps = Math.ceil(c.duration / c.dt - 1e-9);
    for (let step = 0; step < steps; step++) {
      const t = step * c.dt;
      const h = Math.min(c.dt, c.duration - t);
      const nextTime = t + h;
      // Explicit midpoint acceleration gives a second-order ballistic update.
      // A provisional midpoint supports delays smaller than the integration step.
      const middleLead = prescribedLeader(t + h / 2);
      const middle = { t: t + h / 2, x: [middleLead.x], v: [middleLead.v] };
      for (let i = 1; i < c.count; i++) {
        const state = advance(current.x[i], current.v[i], a[i], h / 2);
        middle.x.push(state.x);
        middle.v.push(state.v);
      }
      const stepA = accelerations(middle.t, middle, middle);
      const next = { t: nextTime, x: [], v: [] };
      const lead = prescribedLeader(nextTime);
      next.x[0] = lead.x;
      next.v[0] = lead.v;
      for (let i = 1; i < c.count; i++) {
        const updated = advance(current.x[i], current.v[i], stepA[i], h);
        next.x[i] = updated.x;
        next.v[i] = updated.v;
      }

      // Check within-step minima as well as endpoints. Split ballistic paths at
      // stops, and locate relative-velocity zeros before bisecting first contact.
      // Collisions stop the run; positions are never clamped to manufacture safety.
      let firstContact = null;
      function atOffset(i, offset) {
        return i === 0 ? prescribedLeader(t + offset) : advance(current.x[i], current.v[i], stepA[i], offset);
      }
      for (let i = 1; i < c.count; i++) {
        // No vehicle can contact its leader within this step if it cannot even
        // travel the current gap (the prescribed leader never moves backwards).
        const oldGap = current.x[i - 1] - current.x[i] - c.vehicleLength;
        if (oldGap > next.x[i] - current.x[i] + 1e-10) continue;
        const points = [0, h / 4, h / 2, h * 3 / 4, h];
        for (const car of [i - 1, i]) {
          if (car > 0 && stepA[car] < 0) {
            const stop = -current.v[car] / stepA[car];
            if (stop > 0 && stop < h) points.push(stop);
          }
        }
        if (i === 1 && observed) {
          for (const sampleTime of observed.times) {
            if (sampleTime > t && sampleTime < t + h) points.push(sampleTime - t);
          }
        }
        points.sort((left, right) => left - right);
        const gapAt = offset => atOffset(i - 1, offset).x - atOffset(i, offset).x - c.vehicleLength;
        const gapRateAt = offset => {
          const front = atOffset(i - 1, offset);
          return (front.motionV === undefined ? front.v : front.motionV) - atOffset(i, offset).v;
        };
        const extrema = [];
        for (let part = 1; part < points.length; part++) {
          let lo = points[part - 1], hi = points[part];
          if (gapRateAt(lo + 1e-12) < 0 && gapRateAt(hi - 1e-12) > 0) {
            for (let iteration = 0; iteration < 35; iteration++) {
              const middle = (lo + hi) / 2;
              if (gapRateAt(middle) > 0) hi = middle;
              else lo = middle;
            }
            extrema.push((lo + hi) / 2);
          }
        }
        points.push(...extrema);
        points.sort((left, right) => left - right);
        for (let part = 1; part < points.length; part++) {
          const left = points[part - 1], right = points[part];
          const gap = gapAt(right);
          if (gap <= 0) {
            let lo = left, hi = right;
            for (let iteration = 0; iteration < 35; iteration++) {
              const mid = (lo + hi) / 2;
              if (gapAt(mid) <= 0) hi = mid;
              else lo = mid;
            }
            if (!firstContact || hi < firstContact.offset) firstContact = { offset: hi, follower: i, leader: i - 1 };
            break;
          }
        }
      }
      if (firstContact) {
        const contact = { x: [], v: [] };
        for (let i = 0; i < c.count; i++) {
          const state = atOffset(i, firstContact.offset);
          contact.x.push(state.x);
          contact.v.push(state.v);
        }
        collision = { t: t + firstContact.offset, follower: firstContact.follower, leader: firstContact.leader };
        track(contact, stepA);
        snapshot(collision.t, contact, stepA);
        break;
      }

      history.push(next);
      current = next;
      a = accelerations(nextTime, current);
      track(current, a);
      if ((step + 1) % sampleSteps === 0 || step === steps - 1) snapshot(nextTime, current, a);
    }

    const speedRangeByCar = maximumSpeeds.map((max, i) => max - minimumSpeeds[i]);
    const leadRange = speedRangeByCar[0];
    const tailRange = speedRangeByCar[c.count - 1];
    return {
      config: c, frames, collision, initialGap, observed: Boolean(observed),
      metrics: {
        minimumSpeeds, maximumSpeeds, speedRangeByCar,
        leadRange, tailRange, amplification: leadRange > 1e-7 ? tailRange / leadRange : null,
        minGap: Math.max(0, minGap), maxBrake,
        completedDuration: frames[frames.length - 1].t
      }
    };
  }

  const presets = Object.freeze({
    stable: Object.freeze({ ...defaultConfig, reactionTime: 0.6, timeHeadway: 1.8 }),
    wave: Object.freeze({ ...defaultConfig, reactionTime: 0.94, timeHeadway: 1.35 }),
    stopGo: Object.freeze({ ...defaultConfig, reactionTime: 0.95, timeHeadway: 1.35 })
  });
  return { defaultConfig, presets, run, equilibriumGap, idmAcceleration, leaderAt };
});
