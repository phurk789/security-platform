// Live driving from the console: turning keys and the on-screen pad into stick positions.
// Throttle +1 = full forward, steer +1 = full right. The gateway applies the vehicle's caps.

export interface Sticks {
  throttle: number;
  steer: number;
}

export const CENTRED: Sticks = { throttle: 0, steer: 0 };

/** Stick samples go out this often while a drive is open (the server accepts up to 25 a second). */
export const DRIVE_SEND_MS = 100;

/** Keys that drive: WASD and the arrow keys. Space is the stop key (handled by the panel). */
const FORWARD = ['w', 'arrowup'];
const BACK = ['s', 'arrowdown'];
const LEFT = ['a', 'arrowleft'];
const RIGHT = ['d', 'arrowright'];
export const DRIVE_KEYS = new Set([...FORWARD, ...BACK, ...LEFT, ...RIGHT]);

/** Held keys (lower-case `KeyboardEvent.key`) → sticks. Opposite keys cancel out. */
export function keysToSticks(held: ReadonlySet<string>): Sticks {
  const on = (keys: string[]) => (keys.some((k) => held.has(k)) ? 1 : 0);
  return { throttle: on(FORWARD) - on(BACK), steer: on(RIGHT) - on(LEFT) };
}

/** Pad dead zone (fraction of the radius): a resting finger does not creep the vehicle. */
export const PAD_DEADZONE = 0.12;

/**
 * Pointer position on the round pad, relative to its centre (px, y down) → sticks. Clamped to the
 * circle; inside the dead zone it reads centred, outside it the range is rescaled so the edge of the
 * dead zone is 0 and the rim is 1.
 */
export function padToSticks(dx: number, dy: number, radius: number): Sticks {
  if (!(radius > 0)) return CENTRED;
  let x = dx / radius;
  let y = -dy / radius;
  const r = Math.hypot(x, y);
  if (r > 1) {
    x /= r;
    y /= r;
  }
  const scale = (v: number) => (Math.abs(v) <= PAD_DEADZONE ? 0 : (Math.sign(v) * (Math.abs(v) - PAD_DEADZONE)) / (1 - PAD_DEADZONE));
  return { throttle: round(scale(y)), steer: round(scale(x)) };
}

function round(v: number) {
  return Math.round(v * 100) / 100 || 0;
}
