# UGV Hardware Readiness — implementation increment

This change adds a **read-only** hardware verification panel to the existing UGV Command Center. It deliberately **does not** grant manual drive authority or assert successful SIYI hardware integration.

## What is observable
- Platform telemetry freshness as determined by the existing application policy
- Declared camera/gimbal capabilities (declarations are **not** hardware verification)
- Explicit NOT VERIFIED status for SIYI/MAVLink integration, depth-based obstacle stopping, and physical E-stop

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
