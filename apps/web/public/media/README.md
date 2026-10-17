# Recorded footage for the demo feeds

Put short clips here and the console can show **real recorded video** in place of the 3D render
(feed menu → *Recorded footage*). Clips are always labelled **RECORDED**, never LIVE.

`samples.json` maps a device id (`"UGV-01"`) or a kind default (`"kind:ugv"`, `"kind:cctv"`,
`"kind:uav"`) to a clip:

```json
{ "clips": { "UGV-02": { "src": "media/ugv-02.mp4", "credit": "D100 field test, 12 Oct 2026", "ownDevice": true } } }
```

- `src` is relative to the app root. Keep clips 10–30 s; they loop.
- `credit` is shown on the feed. Set `ownDevice: true` only for footage shot by one of your own
  devices; leave it out for footage from elsewhere (it is then labelled RECORDED · SAMPLE).
- Use footage you have the rights to. Blur faces and number plates where required.

Re-encode for the web (H.264, 720p, no audio, small):

```bash
ffmpeg -i input.mp4 -t 20 -vf "scale=1280:-2,fps=25" -c:v libx264 -preset slow -crf 26 -pix_fmt yuv420p -movflags +faststart -an media/ugv-onboard.mp4
```

SIYI cameras record to their SD card (`.mp4`); the SIYI A8 mini / ZR10 / ZT30 files can be used
as they are after the command above. Gimbal pan/tilt/zoom from the console is applied to the
recorded picture digitally.

Expected default file names: `ugv-onboard.mp4`, `cctv-gate.mp4`, `uav-aerial.mp4`.
