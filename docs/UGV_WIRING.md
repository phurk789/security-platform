# Tracked UGV wiring and ArduPilot setup (draft)

Draft for a tracked carrier with a Loncin petrol engine, a **SIYI UniFC 6 Pico** running
ArduPilot Rover, a SIYI air unit and a **UniRC 7 Pro** remote. Nothing here has been tested on the
vehicle. Parameters: `deploy/vehicle/tracked-ugv-rover.param`.

## Assumptions (confirm before wiring)

| #   | Assumption                                                                            | If different                                                               |
| --- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| A1  | Hydraulic / hydrostatic drive with one travel valve per track, spring-centred neutral | Electric drive: PWM goes to the two motor controllers instead of actuators |
| A2  | One PWM-positioned linear actuator or high-torque servo per valve                     | Clutch-and-brake steering needs a different mix; tell us the mechanism     |
| A3  | Engine speed held by its own governor; the board does not control the throttle        | A throttle servo can be added later on a spare output (manual passthrough) |
| A4  | 12 V battery charged by the engine's charging coil                                    | Size the DC-DC converters to the real battery                              |
| A5  | Loncin engine stops when its kill wire is connected to ground                         | Check the engine manual                                                    |

## Wiring

```
12 V battery ─ fuse ─ key switch ─┬─ DC-DC 5.3 V 3 A ─ UniFC 6 Pico power
                                  ├─ air unit (voltage per SIYI manual)
                                  ├─ SIYI camera (12 V)
                                  └─ safety relay contact B ─ actuator drivers (power)

E-stop chain (series, normally closed):
  mushroom button on the vehicle ─ second button ─ wireless E-stop receiver ─ safety relay coil

Safety relay (de-energised = stop):
  contact A: holds the engine kill wire OFF ground while energised; drops → kill to ground → engine stops
  contact B: actuator power; drops → actuators lose power

UniFC 6 Pico:
  TELEM1  ↔ air unit UART (MAVLink 2, 115200)
  GPS     ↔ GNSS + compass on a mast, away from the engine
  RC IN   ← air unit SBUS out (UniRC 7 Pro sticks and switches)
  PWM 1   → left valve actuator driver
  PWM 3   → right valve actuator driver
Air unit Ethernet ↔ SIYI camera (192.168.144.25)
```

Why the relay works this way: a broken wire, a blown fuse or a pressed button all de-energise the
coil, and every one of them stops the engine. Linear actuators hold their position without power,
so cutting their power alone does not centre the valves; stopping the engine stops the pump,
which is what stops the tracks. Test that on the stand (A1).

## Bring-up order

1. Tracks off the ground (vehicle on stands), engine off. Load the parameter file.
2. Confirm the board's UART map (`SERIAL1` = TELEM1, GPS port) against SIYI's ArduPilot table;
   fix `SERIALn_*` if needed.
3. Servo output page: move each output and set `SERVOn_MIN/TRIM/MAX` to the actuator's real
   reverse / neutral / forward stroke. Set `SERVOn_REVERSED` so forward is forward.
4. RC calibration with the UniRC 7 Pro; check the mode switch (MANUAL / HOLD / AUTO) and the
   arm switch. Set `FS_THR_VALUE` from the receiver's failsafe output.
5. E-stop: each button and the wireless receiver must stop the running engine within 1 s, with
   the board powered off as well.
6. Engine on, tracks still lifted: MANUAL, small stick inputs; then switch the remote off and
   confirm HOLD (valves to neutral).
7. On the ground in a closed area, walking pace (`MOT_THR_MAX` 40): measure `CRUISE_SPEED` and
   `CRUISE_THROTTLE`, then tune steering and speed.
8. Connect the edge gateway (HARDWARE_SIYI.md) and run its 13-step checklist.
