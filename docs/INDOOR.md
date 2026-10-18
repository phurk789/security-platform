# UGVs inside buildings

Short answer: **not yet, but the software side is ready.** A D50 drives through a doorway
(100 mm step, 750 × 700 mm) and a D100 fits most corridors, but the platform today positions
vehicles from GNSS through the flight controller, and there is no GNSS indoors. Three things are
needed on the vehicle and the site before an indoor mission is more than a demo.

## What indoor needs

| Need                               | Why                                                                      | Options (in order of practicality)                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Indoor positioning**             | No GNSS; the platform must know which floor and where on it              | 2D LiDAR SLAM on a companion computer (ROS 2 Nav2, AMCL on the floor map) — proven, ~฿15–40k of hardware per vehicle · UWB beacons (fixed anchors per floor, 10–30 cm) · Visual SLAM (camera-based, cheaper, less robust in dark corridors) · ArduPilot "external navigation" fed by the same SLAM (`VISION_POSITION_ESTIMATE`), so the flight controller keeps driving |
| **A navigable floor map**          | Routes must stay in corridors and rooms, off stairs and lifts            | Export each level from the BIM model (IFC → floor plan → occupancy map for Nav2); the twin uses the same plan for the floor-plan view, room names and the wall-crossing check                                                                                                                                                                                           |
| **A link that goes through walls** | The SIYI image link is line-of-sight; inside it drops within a few rooms | Site Wi-Fi 6 mesh with the edge PC on the same network · Private 5G · **Fibre-optic tether** (the D50/D100 remote supports fibre control; ideal for a single building) · The SIYI link outdoors plus Wi-Fi hand-over indoors                                                                                                                                            |
| **Indoor safety**                  | People, glass, narrow doors, no sky view                                 | Speed limit ≤ 1.5 m/s, bumper / ultrasonic stop, person detection on the camera, doors held open or automated, physical E-stop, pilot escort for the first runs. **Stairs are out**; lifts only with a lift-controller integration (not built)                                                                                                                          |
| **Indoor video**                   | Corridors are dark, Wi-Fi bandwidth is shared                            | The 4-in-1 searchlight; sub-stream for the console; recordings on the camera's SD card                                                                                                                                                                                                                                                                                  |

## What the platform does now

- **Floor plans in the twin.** Buildings carry floor plans (from BIM or a drawing): walls, rooms,
  doors, stairs, lifts. Open one from the building panel or by selecting an indoor device; the 2D
  map shows the plan, the 3D twin cuts the building open at that level.
- **Indoor devices.** A device can be marked indoor (`building`, `level`, positioning source).
  Telemetry carries the level; the device is drawn on the right floor and the panel says
  _Indoor · Building 2 · Level 1 · LiDAR SLAM_ and which room it is in.
- **Wall-aware missions.** For an indoor vehicle the constraint checks become: route inside the
  building, every checkpoint on the vehicle's floor, no leg through a wall, no checkpoint on
  stairs or in a lift. Approval is refused otherwise, exactly like the outdoor checks.
- **Demo.** UGV-04 is a D50 patrolling the Building 5 warehouse (level 1: 12 rack rows, aisles A–K,
  loading dock, fuel store and forklift charging as no-go areas) on a serpentine route through
  every aisle, positioned by (simulated) LiDAR SLAM. Between missions it drives the round on its own
  (offline demo and server mode alike) and hands over as soon as the platform sends a command;
  without GNSS. CCTV-05 watches the Building 2 lobby.
- **Adapters.**
  - `ros2-nav2` (new): talks to a ROS 2 vehicle through rosbridge — pose from AMCL, battery,
    missions as `NavigateThroughPoses`, pause / resume / stop by cancelling and re-sending goals.
    Written to the rosbridge protocol and tested against a simulator, **not yet on a robot**.
  - `mavlink`: with an `indoor` block in the site config it reads `LOCAL_POSITION_NED` (from
    ArduPilot's external-navigation EKF source) instead of GPS.

## Phases

1. **Bench (now):** floor plan imported from the BIM model; vehicle on a trolley; SLAM pose shown
   in the twin; wall checks on a planned route.
2. **Escorted indoor runs:** one corridor, doors held open, pilot escort, ≤ 1 m/s; verify
   position error (< 0.3 m), link hand-over, stop on E-stop and on link loss.
3. **Routine patrols:** fixed routes per floor, searchlight on, recording; lift and door
   integration if needed (separate project).

## Setting up a ROS 2 vehicle

```json
{
  "type": "ros2-nav2",
  "deviceId": "UGV-04",
  "kind": "ugv",
  "url": "ws://192.168.144.60:9090",
  "indoor": { "buildingId": "B2", "level": 1 },
  "frame": { "originX": 178, "originY": 88, "yawDeg": 0 },
  "topics": { "pose": "/amcl_pose", "odom": "/odom", "battery": "/battery_state" },
  "action": "/navigate_through_poses",
  "maxSpeedMps": 1.5
}
```

`frame` places the ROS map origin on the site grid (metres; `yawDeg` turns the map's +x
clockwise from site east). Install `rosbridge_server` on the companion computer
(`ros2 launch rosbridge_server rosbridge_websocket_launch.xml`). The adapter needs Nav2 running
with the floor map loaded.
