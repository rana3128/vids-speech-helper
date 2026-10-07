# Vids Autopilot

A Chrome extension (Manifest V3, plain JS) that automates two steps in Google Vids for a video with one long MP4 clip on its timeline:

1. **Split**: cut the clip into scenes at the start times in `video.json`.
2. **Fill voiceovers**: give every scene an AI voiceover (voice "Holt") with that scene's script.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this `vids-autopilot/` folder.
4. Pin the extension (puzzle icon → pin), then **reload** any open Vids tab.

After editing any file, click the reload icon on the extension card, then reload the Vids tab.

## Input file

`video.json`:

```json
{
  "title": "My video",
  "duration": 486.4,
  "voice": "Holt",
  "scenes": [
    { "start": 0,    "speech": "[slow pace] Welcome ..." },
    { "start": 23.8, "speech": "[slow pace] When you run ..." }
  ]
}
```

- `start` values are in seconds, in ascending order, and the first one is `0`.
- A speech longer than 800 characters gets a warning but isn't blocked.

A legacy `.txt` file also works. Each block starts with a header like `===== SCENE 2 — Variables (starts 0:23.80) =====`. In this case the duration comes from the page timer.

## Usage (in this order)

Open the video at `https://docs.google.com/videos/d/<id>/edit` with the timeline visible, then click the extension icon.

1. **Load file**: the summary shows the scene count, the duration and the longest speech.
2. **Calibrate**: sets the zoom to 100% and measures:
   - the track start, px/second, the gap per split and the ruler Y position;
   - then it test-seeks to 5 s and checks the timer.

   Every value is written to the log. Split runs Calibrate on its own every time.
3. **Split scenes**: splits the clip at every start time.
   - After each split it checks that the scene count went up by one, and that the new scene starts at the right time.
   - Try a 3-scene test video first.
4. **Fill voiceovers**: with the **AI voiceover** panel open, for each scene it:
   - shows the scene in the panel;
   - checks the voice is Holt;
   - types the script with real input and checks the text;
   - clicks **Insert voiceover** and waits for generation to finish.

   At the end it audits the **All scenes** tab.

**Run all** runs Calibrate → Split → Fill.

**Stop** cancels between steps (and inside any wait) and releases the debugger.

**Resuming:** progress (the split points done and the last filled scene) is saved per video in `chrome.storage.local`.
- Re-running skips work that's already done.
- **Start from scene #** jumps ahead.
- **Reset progress** forgets the saved progress.
- The log survives closing the popup and reloading the page.

## The "is debugging this browser" banner

A content script can't press a real Cmd/Ctrl+Shift+S, or type into Vids' canvas-based script editor. So the background worker uses `chrome.debugger` to send trusted key presses, clicks and text. While it's attached, Chrome shows a yellow **"Vids Autopilot started debugging this browser"** bar. This is expected. The extension detaches when a run ends and when you press Stop.

**Don't click "Cancel" on the bar during a run.** If you do, the run stops cleanly.

If the debugger key fails, the extension tries a "Split" item in the right-click menu.

## When something isn't found: Inspect DOM → Claude Code → config.js

Google changes the Vids UI. All selectors, labels and delays live in [`config.js`](config.js). They were verified against Vids in October 2026. If a later Vids update breaks one:

1. Open the state you're stuck at, for example the voiceover panel open on a scene.
2. Click **Inspect DOM**. It copies JSON with every visible labelled or interactive element (tag, role, aria-label, text, rect) to the clipboard.
3. Paste it to Claude Code: "fix config.js for this".
4. Reload the extension and the tab, then run again.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Timeline scroller not found" | Make the timeline visible, then reload the tab. |
| "Timeline is not at 100% zoom" | Set the zoom to 100% by hand and run again. If the zoom control was not found, run Inspect DOM. |
| Test seek fails at every ruler offset | Run Inspect DOM with the timeline visible and share the output. You can also adjust `rulerAboveThumbsPx` in `config.js`. |
| Seek is always off by the same amount | Re-run Calibrate. Make sure the zoom reads 100%. |
| A split lands at the wrong time | The run stops. Press **Cmd/Ctrl+Z** in Vids, run Calibrate, then set "Start from scene #" to the scene shown in the log. |
| A voiceover panel, textbox or Insert button is not found | Use the Inspect DOM loop above. |
| Buttons do nothing | Reload the extension and the Vids tab. |

## Known limitations

- **UI changes:** Vids has no API. A Google UI update can break selectors until `config.js` is updated.
- **Don't resize the window or change the zoom mid-run.** The calibration depends on pixel geometry. If the viewport size changes, Calibrate runs again on the next start.
- Keep the Vids tab visible and in the foreground while a run is going.
- The skip/resume check assumes splits are made left to right.
- If a voiceover is longer than its scene, the extension doesn't fix it. Shorten the speech or lengthen the scene.
