// Read-only guard for the SIYI bench probe. Every outgoing MAVLink message passes through
// assertSendAllowed() before it reaches the socket, so the probe cannot arm, change mode,
// upload a mission, override RC or write a parameter even if the code around it is wrong.

/** Message ids the probe may send, with the reason each one is safe. */
export const ALLOWED_OUTGOING: ReadonlyMap<number, string> = new Map([
  [0, 'HEARTBEAT — GCS presence only (type GCS, base mode 0); carries no command'],
  [20, 'PARAM_REQUEST_READ — read one parameter'],
  [21, 'PARAM_REQUEST_LIST — read all parameters'],
]);

export class ForbiddenMessageError extends Error {}

export function assertSendAllowed(msgId: number, name = `message ${msgId}`): void {
  if (!ALLOWED_OUTGOING.has(msgId)) {
    throw new ForbiddenMessageError(`Bench probe is read-only: refusing to send ${name} (id ${msgId})`);
  }
}

/** A GCS heartbeat must not claim to be an autopilot or carry mode flags. */
export function assertGcsHeartbeat(hb: { type: number; autopilot: number; baseMode: number; customMode: number }): void {
  if (hb.type !== 6 || hb.autopilot !== 8 || hb.baseMode !== 0 || hb.customMode !== 0) {
    throw new ForbiddenMessageError('Bench probe heartbeat must be type GCS (6), autopilot INVALID (8), base and custom mode 0');
  }
}
