(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Motion = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const BLANK_MS = 1000, TURN_MS = 150, MAX_DURATION_MS = 120000;

  function positive(value, name) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new RangeError(name + ' must be a finite positive number');
    }
    return value;
  }
  function identity(run, step) {
    if (typeof run !== 'string' || !/^[0-9a-fA-F]{8}$/.test(run)) throw new RangeError('run_id must be eight hexadecimal digits');
    if (!Number.isInteger(step) || step < 0 || step > 0xffffffff) throw new RangeError('step_id must be uint32');
    return run.toLowerCase();
  }
  function markerBits(run_id, step_id) {
    const run = identity(run_id, step_id);
    const bytes = [0xd1];
    for (let i = 0; i < 8; i += 2) bytes.push(parseInt(run.slice(i, i + 2), 16));
    for (let shift = 24; shift >= 0; shift -= 8) bytes.push((step_id >>> shift) & 255);
    let crc = 0;
    for (const byte of bytes) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = ((crc << 1) ^ ((crc & 0x80) ? 0x07 : 0)) & 255;
    }
    bytes.push(crc);
    return bytes.flatMap(byte => Array.from({ length: 8 }, (_, bit) => (byte >>> (7 - bit)) & 1));
  }
  function planMotion(input) {
    if (!input || typeof input !== 'object') throw new TypeError('config is required');
    const c = {};
    for (const name of ['width', 'height', 'image_width', 'image_height', 'target_width_px', 'max_speed_px_s', 'acceleration_px_s2']) c[name] = positive(input[name], name);
    if (!Number.isInteger(input.laps) || input.laps < 1 || input.laps > 20) throw new RangeError('laps must be an integer from 1 to 20');
    c.laps = input.laps;
    if (!Array.isArray(input.bbox) || input.bbox.length !== 4 || !input.bbox.every(Number.isFinite)) throw new RangeError('bbox must contain four finite numbers');
    c.bbox = input.bbox.slice();
    const [l, t, r, b] = c.bbox;
    if (l < 0 || t < 0 || r <= l || b <= t || r > c.image_width || b > c.image_height) throw new RangeError('bbox must be inside the image');
    const scale = c.target_width_px / (r - l);
    const iw = c.image_width * scale, ih = c.image_height * scale;
    const m = Math.max(4, Math.round(c.width / 100));
    const marker = { x: 16 + m, y: 16 + m, module_px: m };
    const left = 16, top = 32 + 10 * m, right = c.width - 16, bottom = c.height - 16;
    const inset = 24;
    const dx = right - left - 2 * inset - iw, dy = bottom - top - 2 * inset - ih;
    if (![scale, iw, ih, dx, dy].every(Number.isFinite) || dx <= 0 || dy <= 0 || 16 + 12 * m > c.width - 16) throw new RangeError('image or marker does not fit the screen');
    const x0 = left + inset, y0 = top + inset;
    const positions = [[x0, y0], [x0 + dx, y0], [x0 + dx, y0 + dy], [x0, y0 + dy], [x0, y0]];
    function leg(distance, from, to) {
      const a = c.acceleration_px_s2, v = c.max_speed_px_s;
      const peak = Math.min(v, Math.sqrt(distance * a));
      const ramp = peak / a;
      const cruise = Math.max(0, (distance - peak * ramp) / peak);
      return { from, to, distance, peak, ramp_s: ramp, cruise_s: cruise, duration_ms: (2 * ramp + cruise) * 1000 };
    }
    const legs = positions.slice(0, 4).map((p, i) => leg(i % 2 === 0 ? dx : dy, p, positions[i + 1]));
    const lap_ms = legs.reduce((sum, item) => sum + item.duration_ms + TURN_MS, 0);
    const duration_ms = BLANK_MS * 2 + c.laps * lap_ms;
    if (!Number.isFinite(duration_ms) || duration_ms > MAX_DURATION_MS) throw new RangeError('run duration exceeds 120 seconds');
    return { config: c, duration_ms, calibration_points: [[left, top], [right, top], [right, bottom], [left, bottom]], marker, scale, image_size_px: [iw, ih], legs, lap_ms };
  }
  function sampleMotion(plan, elapsed_ms, step_id, run_id) {
    const run = identity(run_id, step_id);
    if (typeof elapsed_ms !== 'number' || !Number.isFinite(elapsed_ms)) throw new RangeError('elapsed_ms must be finite');
    const elapsed = Math.max(0, elapsed_ms);
    const result = { run_id: run, step_id, elapsed_ms: elapsed, phase: 'blank_before', visible: false, bbox_screen_px: null, velocity_px_s: [0, 0], acceleration_px_s2: [0, 0], image_rect_px: null };
    if (elapsed < BLANK_MS) return result;
    if (elapsed >= plan.duration_ms - BLANK_MS) { result.phase = 'blank_after'; return result; }
    let time = (elapsed - BLANK_MS) % plan.lap_ms;
    let chosen = plan.legs[plan.legs.length - 1];
    for (const leg of plan.legs) {
      if (time < leg.duration_ms + TURN_MS) { chosen = leg; break; }
      time -= leg.duration_ms + TURN_MS;
    }
    const { distance, peak, ramp_s, cruise_s, from, to } = chosen;
    const ux = (to[0] - from[0]) / distance, uy = (to[1] - from[1]) / distance;
    const a = plan.config.acceleration_px_s2;
    let pos, speed, accel;
    const s = time / 1000;
    if (time >= chosen.duration_ms) { result.phase = 'turn'; pos = distance; speed = 0; accel = 0; }
    else if (s < ramp_s) { result.phase = 'accelerate'; pos = a * s * s / 2; speed = a * s; accel = a; }
    else if (s < ramp_s + cruise_s) { result.phase = 'cruise'; pos = peak * ramp_s / 2 + peak * (s - ramp_s); speed = peak; accel = 0; }
    else { const remaining = Math.max(0, (chosen.duration_ms - time) / 1000); result.phase = 'brake'; pos = distance - a * remaining * remaining / 2; speed = a * remaining; accel = -a; }
    const x = from[0] + ux * pos, y = from[1] + uy * pos;
    const [l, t, r, b] = plan.config.bbox, scale = plan.scale;
    result.visible = true;
    result.image_rect_px = [x, y, x + plan.image_size_px[0], y + plan.image_size_px[1]];
    result.bbox_screen_px = [x + l * scale, y + t * scale, x + r * scale, y + b * scale];
    result.velocity_px_s = [ux * speed, uy * speed];
    result.acceleration_px_s2 = [ux * accel, uy * accel];
    return result;
  }
  return { planMotion, sampleMotion, markerBits };
});
