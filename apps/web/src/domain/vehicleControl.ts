// Arm, disarm, MANUAL/HOLD and gear from the console (VehicleControls.tsx), and the pairing choices for a vehicle run
// without a hand-held remote (the gateway on its Pi is the remote; apps/gateway/src/real/virtualRemote.ts).

/** The gear the gateway reports in its "Virtual remote" part ("… gear 2 of 3 …"), if any. */
export function gearOf(detail?: string): number | undefined {
  const m = /\bgear (\d+) of \d+/.exec(detail ?? '');
  return m ? Number(m[1]) : undefined;
}

/** How a Pi-run vehicle is controlled by hand. */
export type RemoteChoice = 'remote' | 'none-rcu' | 'none';

/**
 * The RCU-ND motor board of UGV-01: its enable/speed input (C6) is fed from RC channel 11 (SERVO4 = RCIN11Scaled),
 * RC11_MIN / TRIM / MAX = 1100 / 1500 / 1900 → gears 1 / 2 / 3.
 */
export const RCU_ND_GEARS = { gearChannel: 11, gears: [1100, 1500, 1900] };

/** site.json `noRemote` for each choice. "none-rcu": the gateway holds the RCU-ND gear channel (RCU_ND_GEARS). */
export function noRemoteFor(choice: RemoteChoice): Record<string, unknown> | undefined {
  if (choice === 'none-rcu') return { noRemote: { ...RCU_ND_GEARS } };
  if (choice === 'none') return { noRemote: true };
  return undefined;
}
