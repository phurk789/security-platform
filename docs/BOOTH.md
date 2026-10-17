# Live demo at a booth

How to run the platform live at an exhibition: what can go wrong, what the software does about
it, what to bring, and the run-of-show. Thai talking points are built into the console.

## What goes wrong at booths, and what we do about it

| Risk                                           | What happens                          | What the platform does                                                                                                                                                                                                                                                                               |
| ---------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Presenter clicks through 3 roles while talking | Wrong role, missed step, dead air     | **Booth script** (press **B**): one _Next_ button per step switches the role and performs the action; the talking point is on screen. Space / → next, A auto-play, R reset, P big screen                                                                                                             |
| Nobody at the booth                            | Screen looks static, people walk past | **Auto-play loop**: the whole script runs by itself, with large captions, then resets and repeats. Press any booth key to take over                                                                                                                                                                  |
| Venue Wi-Fi / 4G fails                         | Cloud demo dies                       | The **offline build** (`npm run build:demo` → one HTML file) runs entirely in the browser. Keep it as the default; the server version is optional                                                                                                                                                    |
| Someone asks "is this real?"                   | Credibility                           | Every simulated device carries a **SIM** tag, the header says **SIMULATION**, and real hardware is labelled **TESTING / VERIFIED**. Feeds say SIMULATED, RECORDED or LIVE. Say so before they ask                                                                                                    |
| Real vehicle misbehaves in a crowd             | Safety incident                       | Vehicles stay **simulated** on the big screen. Real hardware at the booth is limited to the **SIYI camera on a tripod** (pan/tilt/zoom from the console) and, if a fenced pen is available, a **D100 with the pilot holding the UniRC 7 Pro** and the physical E-stop in reach                       |
| State left over from the last visitor          | Demo starts mid-flow                  | _Reset demo dataset_ (R in the booth script) returns to the opening state in one click                                                                                                                                                                                                               |
| Small text on a TV                             | Visitors cannot read it               | **Presentation mode** (P) enlarges the UI; captions are sized for 2–3 m. **Wall display** (W, or open the build with `?kiosk`) hides the operator chrome, centres the captions and runs a live event ticker along the bottom                                                                         |
| Laptop GPU too weak for four 3D views          | Stutter                               | The **performance guard** drops the twin to low quality by itself when it cannot hold ~22 fps for a few seconds (a toast says so; the Layers menu shows the fps and lets you switch back). You can also turn the fleet video off (Fleet panel → _Video_) or use the classic layout                   |
| Screen looks static between steps              | People walk past                      | The twin is alive on its own: people on the plaza and walkways, traffic on the road, the **simulated drone** moving to orbit a verified alert, the **alert's subject** standing at the gate who walks away when the vehicle announces. Incident thumbnails are live pictures from the twin's cameras |
| Silent screen in a loud hall                   | No attention                          | **Sound** (S, or the speaker button): a chime for a new alert, a blip when the vehicle confirms a command, a warning tone for the failsafe stop, and the loudhailer preset read aloud (Thai or English). Off by default; turning it on is the click that unlocks audio                               |

## Real video at the booth

Each camera feed has a source menu (film icon on the feed):

| Source                 | Label on screen                | What it is                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3D twin                | SIMULATED FEED                 | Rendered from the digital twin (default)                                                                                                                                                                                   |
| Recorded footage       | RECORDED · OWN DEVICE / SAMPLE | Real clips you put in `apps/web/public/media/` (see the README there). Gimbal pan/tilt/zoom from the console is applied to the picture digitally. Use your own test recordings from the D-series vehicles and SIYI cameras |
| This computer's camera | LIVE · LOCAL CAMERA            | The laptop's webcam or a USB camera clipped to the tripod: a real live picture with no infrastructure. Needs HTTPS or localhost; not available inside the claude.ai preview                                                |
| SIYI camera            | LIVE                           | A real SIYI camera through MediaMTX on the edge PC (`deploy/edge/`), registered in a pilot org                                                                                                                             |

The label always says which it is. A recorded clip is never shown as LIVE.

## Kit

- Laptop with a dedicated GPU (or a recent integrated one), Chrome or Edge. Battery plus mains.
- TV or monitor ≥ 43″, HDMI. Mirror or extend: **TV shows the console in presentation mode;
  laptop keeps the booth script panel** (extend, then drag the browser to the TV and open a
  second window on the laptop for the script, or simply mirror).
- Phone or tablet with the **field app** (`/field/`) for the responder part.
- Optional real hardware: SIYI ZT30/ZR30/A8 mini on a tripod with its air unit, UniRC 7 Pro,
  edge PC with the gateway and MediaMTX (`deploy/edge/`), registered in a **pilot** org.
- Printed one-pager: what is simulated, what is real, what the pilot would include.

## Run-of-show (≈ 3 min, built into the booth script)

| #   | Who     | Step                           | Proves                                                                                                                                                                         |
| --- | ------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Alex    | One view of the site           | Map, cameras, vehicles; readiness is real, simulation is labelled                                                                                                              |
| 2   | Alex    | AI detection, rules decide     | A thermal hotspot from analytics becomes a high-severity incident with the frame as evidence; motion would be ignored, vehicles only logged (Administration → Detection rules) |
| 3   | Alex    | Open the camera                | Alert stays unverified until a person looks; nearest camera auto-pointed                                                                                                       |
| 4   | Alex    | Confirm the alert              | Every decision audited with who / when                                                                                                                                         |
| 5   | Alex    | Plan the UGV route             | Draft is dashed; nothing moves yet                                                                                                                                             |
| 6   | Alex    | Submit for approval            | Constraint checks                                                                                                                                                              |
| 7   | Nida    | Supervisor approves            | Role enforced by the API; route change withdraws approval                                                                                                                      |
| 8   | Somchai | Operator takes control         | One control holder; handover logged                                                                                                                                            |
| 9   | Somchai | Send start                     | Sent → acknowledged → confirmed by movement                                                                                                                                    |
| 10  | Somchai | Drone overwatch (simulated)    | The simulated drone is already orbiting the alert; aerial view on its panel. No real aircraft flies                                                                            |
| 11  | Somchai | Warning light and announcement | 4-in-1 module from the console, logged; the person at the gate walks away                                                                                                      |
| 12  | Alex    | Cut the network                | STALE, commands held, vehicle's own failsafe                                                                                                                                   |
| 13  | Alex    | Restore the network            | Nothing replayed; mission paused                                                                                                                                               |
| 14  | Somchai | Resume to the gate             | Evidence attached with checksum; the Recordings timeline plays any stretch back and saves it as a clip                                                                         |
| 15  | Alex    | Record the outcome             | A false alarm is still a complete record                                                                                                                                       |
| 16  | Alex    | Close and report               | Report with approver, commands, evidence; exports logged                                                                                                                       |
| 17  | Priya   | Replay for the auditor         | Controls off in replay; audit chain verifiable                                                                                                                                 |

The 3D camera follows the script: wide idle orbit at the start, the gate when the alert is
reviewed, the route when it is planned, then it follows UGV-01 and the drone. The moment a
visitor drags or scrolls the view, the script leaves the camera alone for 25 s.

Extras when there is time: Command center (UGV & UAV page) with the D100 searchlight; point
CCTV-02 by hand and back at the incident; light theme for daytime scenes; the field app on a
phone (assign INC-022 to Kittipong, accept, report with a photo, show the sync).

## Keys (booth script open)

| Key      | Does                                                               |
| -------- | ------------------------------------------------------------------ |
| B        | Open / hide the presenter panel                                    |
| Space, → | Next step (switches role, performs the action)                     |
| ←        | Previous caption                                                   |
| A        | Auto-play loop on / off (attract mode)                             |
| R        | Reset the demo dataset                                             |
| P        | Big text (presentation mode)                                       |
| W        | Wall display: no side nav, footer or presenter panel; event ticker |
| S        | Sound on / off                                                     |
| Esc      | Hide the panel and stop auto-play                                  |

Two screens: open the build twice. On the TV window add `?kiosk` to the URL (wall display,
auto-play, big text start by themselves); keep the laptop window for the presenter panel. The
two windows do not share state, so use the TV window for the walkthrough and the laptop for the
talking points, or mirror one window.

## Before the doors open

1. Open the offline build in a fresh browser profile; set TH or EN; press **P** on the TV (or
   open it with `?kiosk`).
2. Press **B**, run the script once end to end (≈ 3½ min). Fix anything odd, then **R**.
3. Press **S** once and check the chime plays through the TV speakers; the announcement step
   should be heard as speech (Chrome ships Thai and English voices on Windows and macOS).
4. If real hardware is present: check the camera shows **LIVE** and PTZ confirms; run checklist
   items 11–13 from `HARDWARE_SIYI.md`.
5. Leave **auto-play on** (A) between visitors; the camera orbits slowly until the next step.

## Answers to keep ready

- _Is this live?_ The console and rules are real; vehicles and cameras on screen are simulated
  and labelled. The camera on the tripod is real. Real vehicles are connected through the same
  gateway (SIYI UniFC 6 Pico via UniRC 7 Pro) and are in hardware testing.
- _Is the drone real?_ No. The airframe on the stand is static; the drone on screen is a
  simulation that orbits a verified alert so the console can show the aerial view it would get.
- _Can it drive the robot by itself?_ No. The flight controller drives; the platform uploads an
  approved route and asks for start / pause / stop. The pilot's remote always wins.
- _What happens if the link drops?_ You just saw it: the vehicle stops by its own failsafe, the
  console shows STALE, and nothing is replayed when it reconnects.
- _Where is the data?_ On this laptop. The pilot runs on a server you control, with per-org
  isolation, signed media links and a hash-chained audit log.
