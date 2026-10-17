# Vehicles: route planning, geofences, scheduled patrols, service

What the platform adds on top of the mission workflow (draft → approval → operator → start) so a
fleet of ground vehicles and aircraft can be run day to day.

## Route planning

`planRoute(from, to, { fences, kind, via })` in `packages/shared/src/routing.ts` is an A\* planner
on a 2 m grid of the site. Ground vehicles stay 3 m off buildings, cross the perimeter only through
the service gate and never enter an active keep-out zone; aircraft ignore buildings and ground
keep-outs but respect no-fly zones. The grid path is pulled tight into a handful of corners, which
is what the mission planner submits for approval, so a supervisor still sees and approves a short,
readable route.

- Console: _Prepare mission_ offers **Auto-planned to the alert** (checkpoints, length, ETA) as the
  default route when the planner finds one; presets and indoor floor patrols stay available.
- API: `POST /routes/plan { deviceId, incidentId | to: {x, y}, via?: [...] }` → `{ ok, checkpoints,
lengthM, etaS }` or `{ ok: false, reason }`.
- Every submitted route, from any client, is re-checked on the server: a route that enters a
  keep-out zone is refused (409) and the pre-approval checks show **Route clear of keep-out zones**.

## Nearest unit

`GET /incidents/{id}/suggest` ranks the site's vehicles by estimated arrival at the incident
(planned route length over patrol speed plus a start allowance), with readiness, battery and the
reason a vehicle cannot go (telemetry stale, battery, on another mission, no clear route). The
console shows the ETA on every vehicle card in _Prepare mission_ and marks the nearest ready one;
offline it computes the same ranking in the browser.

## Geofences

| Kind         | Ground vehicles                                                                                           | Aircraft                                 |
| ------------ | --------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **Keep-out** | Routes refused; entering raises a breach (alert on the timeline, notice, audit `geofence.breach`, metric) | Same                                     |
| **Caution**  | Routes allowed; entering is noted (warning on the timeline)                                               | —                                        |
| **No-fly**   | —                                                                                                         | Routes refused; entering raises a breach |

Zones are polygons on the site grid, active or inactive, each applying to UGV and/or UAV. A new
site starts with three examples (fuel store keep-out, Building 2 roof no-fly, plaza caution).
Supervisors and administrators manage them (Administration → Geofences; API `GET/POST/PATCH/DELETE
/geofences`). The map draws them hatched in red (keep-out), amber (caution) and violet (no-fly);
the 3D twin shows the same outlines on the ground. Layer toggle: _Geofences_.

## Scheduled patrols

A patrol schedule names a vehicle, an operator, a route (a preset loop back to the dock, planned
around keep-out zones) and a timetable: weekdays and HH:MM times in the organisation's time zone.
The supervisor who saves it gives a **standing approval** for that route (step-up required, audited
`patrol.create`). On each run the platform:

1. Raises a patrol incident (`type: Scheduled patrol`, verified by the schedule, not shown as an
   alert) and a mission already **approved** under the supervisor's standing approval.
2. Without _auto-start_, waits for the operator to accept and start as for any mission.
3. With _auto-start_, assigns the vehicle to the operator and sends `start`. The operator holds the
   controls throughout and can pause or stop; link-loss behaviour is unchanged.
4. Checks the route against keep-out zones and the vehicle's readiness first. A run that cannot
   start is **skipped** with the reason (audit `patrol.skip`, notice to the console).
5. When the vehicle reaches the last checkpoint, closes the patrol incident with "Patrol
   completed", keeps its evidence and timeline, and releases control.

Console: Missions → _Scheduled patrols_ (list, next run, last outcome, run now, enable/disable).
API: `GET/POST/PATCH/DELETE /patrols`, `POST /patrols/{id}/run`. The scheduler runs every 10 s on
the server (`Platform.runPatrols`).

## Usage counters, service and docking

From telemetry the platform keeps, per vehicle: odometer (m), runtime in motion (s), missions
completed, and the wear since the last service against a service interval (default 500 km / 250 h
for ground vehicles, 100 flight hours for aircraft). Devices page → _Usage_ and _Service_ columns:
**OK**, **Service soon** (80 %) or **Service due**. Administrators record a service visit
(`POST /devices/{id}/service { note }`, audited `device.service`) and set intervals and the dock
position (`PATCH /devices/{id}/stats`). A vehicle parked within 4 m of its dock with no active
mission shows **Docked**; the simulated vehicles charge while docked.

## Status

| Part                             | Status     | Tests                                                                                             |
| -------------------------------- | ---------- | ------------------------------------------------------------------------------------------------- |
| Route planner, geofence geometry | Done       | `vehicles.test.ts` (around buildings, keep-out, gate, no-fly)                                     |
| Geofences on the platform        | Done       | `vehicles.test.ts` (defaults, create, refuse route, deactivate)                                   |
| Nearest-unit suggestion          | Done       | `vehicles.test.ts`                                                                                |
| Scheduled patrols                | Done (sim) | `vehicles.test.ts` (standing approval, auto-start to completion, skip, scheduler tick, time zone) |
| Usage counters and service       | Done (sim) | `vehicles.test.ts`                                                                                |
