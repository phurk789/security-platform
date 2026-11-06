// A vehicle run without a hand-held remote (`noRemote` in site.json): the gateway on the vehicle's computer is its
// remote. While the server has the vehicle it sends RC_CHANNELS_OVERRIDE ten times a second: sticks centred (or the
// console driver's sticks) and, on vehicles whose motor board needs it, the gear channel. When it stops (server link
// lost for `serverLossMs`, gateway or computer down, cable pulled) the flight controller loses its "remote" within
// RC_OVERRIDE_TIME and its radio failsafe holds the vehicle (FS_THR_ENABLE = 1, FS_ACTION = 2 on our rovers),
// also in AUTO. The arm switch and the mode switch channels are never sent: arming and modes go by MAVLink command.

export interface NoRemoteConfig {
  /**
   * RC channel whose value switches the motor board on and picks its speed. UGV-01: channel 11 → SERVO4
   * (RCIN11Scaled) → RCU-ND C6, which turns the motors off below about 1300 µs. Leave out when there is none.
   */
  gearChannel?: number;
  /** RC value for each gear, slowest first (UGV-01: RC11_MIN / TRIM / MAX = 1100 / 1500 / 1900). Gear 1 at every arm. */
  gears?: number[];
  /** Stop being the remote once the server link has been down this long (ms, 1000–30000). */
  serverLossMs?: number;
}

export const NO_REMOTE_DEFAULTS = { serverLossMs: 3000 };

export type NoRemoteSettings = { gearChannel?: number; gears: number[]; serverLossMs: number };

export function noRemoteSettings(n: true | NoRemoteConfig): NoRemoteSettings {
  const c = n === true ? {} : n;
  return { gearChannel: c.gearChannel, gears: c.gears ?? [], serverLossMs: c.serverLossMs ?? NO_REMOTE_DEFAULTS.serverLossMs };
}

/** What is wrong with a site.json `noRemote`, or undefined. `sticks` are the steering and throttle channels in use. */
export function noRemoteProblem(n: unknown, sticks: number[]): string | undefined {
  if (n === undefined || n === true) return undefined;
  if (!n || typeof n !== 'object') return 'noRemote must be true or an object';
  const c = n as Record<string, unknown>;
  const channel = (v: unknown) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 18;
  if (c.gearChannel !== undefined) {
    if (!channel(c.gearChannel)) return 'noRemote.gearChannel must be an RC channel 1–18';
    if (sticks.includes(c.gearChannel as number)) return 'noRemote.gearChannel must not be the steering or throttle channel';
  }
  if (c.gears !== undefined) {
    const g = c.gears as unknown[];
    if (!Array.isArray(g) || g.length < 1 || g.length > 6 || g.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 800 || v > 2200))
      return 'noRemote.gears must list 1–6 RC values between 800 and 2200 µs, slowest first';
  }
  if ((c.gearChannel === undefined) !== (c.gears === undefined)) return 'noRemote.gearChannel and noRemote.gears go together';
  if (c.serverLossMs !== undefined && (typeof c.serverLossMs !== 'number' || c.serverLossMs < 1000 || c.serverLossMs > 30000))
    return 'noRemote.serverLossMs must be between 1000 and 30000';
  return undefined;
}
