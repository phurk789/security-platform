# UGV Hardware Readiness — implementation increment

This change adds a **read-only** hardware verification panel to the existing UGV Command Center. It deliberately **does not** grant manual drive authority or assert successful SIYI hardware integration.

## What the panel shows

Shown in the Command Center side column (below the mission and camera controls) for **real** UGVs
only (integration `testing` or `verified`); simulated vehicles have no hardware to check.

| Row | Passes when |
| --- | --- |
| Vehicle telemetry | Telemetry is fresh. A link check only, never a hardware sign-off |
| Controller (SIYI / MAVLink) | Every flight-controller, computer, remote and radio part the adapter declares reports `ok` |
| Onboard / PTZ camera | Every camera and gimbal part reports `ok` |
| Depth vision / obstacle stop | The lidar or depth camera reports `ok`; with none fitted the row says there is no automatic stop |
| Physical E-stop / engine failsafe | The device's integration status is `verified`, set by an administrator after the site tests below |

The worst part decides a row. Rows use the same status badges as the Equipment tab. Logic and
tests: `apps/web/src/domain/readiness.ts`, `readiness.test.ts`.

## Required before vehicle operation
1. Confirm the actual SIYI model, installed firmware, pinout, MAVLink serial transport and link bandwidth.
2. Inspect the Loncin engine's actuator / throttle / steering / braking wiring and confirm a documented low-level controller interface.
3. Wire an independently operable physical E-stop and prove engine/throttle/brake safe state when power or radio link drops.
4. Test local RC priority over remote/autonomous commands, arming safeguards, lease expiry and telemetry loss.
5. Commission PTZ and depth cameras with calibration and blind-zone assessment; depth detections must not be the only emergency stop layer.
6. Verify battery and engine readings independently; avoid treating simulated state as physical measurements.
7. Record date, operator, device firmware, test outcomes and evidence before changing deployment status from TESTING.

## Validation still needed
- Run `npm ci && npm run typecheck && npm test && npm run build` in CI.
- Run a supervised physical bench test and closed-course drive test. **No physical hardware tests were performed as part of this change.**
