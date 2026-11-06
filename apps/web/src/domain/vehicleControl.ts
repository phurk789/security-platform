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
 * site.json `noRemote` for each choice. "none-rcu": the RCU-ND motor board of UGV-01, which needs its enable/speed
 * input (C6) fed from RC channel 11: RC11_MIN / TRIM / MAX = 1100 / 1500 / 1900 → gears 1 / 2 / 3.
 */
export function noRemoteFor(choice: RemoteChoice): Record<string, unknown> | undefined {
  if (choice === 'none-rcu') return { noRemote: { gearChannel: 11, gears: [1100, 1500, 1900] } };
  if (choice === 'none') return { noRemote: true };
  return undefined;
}
