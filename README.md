# vids-speech-helper

Turn a Claude chat into a narrated video tutorial in Google Vids.

Claude makes the **picture** (an animated MP4, with no audio) and the **script** (a `video.json` with each scene's start time and narration). The **Vids Autopilot** Chrome extension in [`vids-autopilot/`](vids-autopilot/) does the slow parts in Google Vids:

1. It cuts the MP4 into scenes at the exact start times.
2. It adds an AI voiceover (voice "Holt") to every scene.

You only review and export the result.

```
Claude chat ──► video.mp4 (animation, no audio) ──┐
            └─► video.json (start times + script) ─┤
                                                   ▼
                    Google Vids + Vids Autopilot: split → AI voiceover per scene → export
```

---

## Step 1: Generate the MP4 and the JSON with Claude

Ask Claude, in a chat that can run code, to make the animation and the script **together**. That way the scene start times in the JSON match the cuts in the MP4 exactly.

**Example prompt** (edit the topic, length and style):

> Make an animated explainer video for my interview-prep series.
>
> **Topic:** Python FastAPI, Video 1: How Python runs, variables and core types.
> **Length:** about 8 minutes, 15–20 scenes.
>
> **Deliverable 1: `video.mp4`**
> - 1920×1080, 30 fps, H.264, **no audio track** (narration is added later in Google Vids).
> - Render it with code (for example Python with manim, or matplotlib/Pillow frames plus ffmpeg).
> - Use a clean dark theme with large readable code, and animate step by step (type code line by line, highlight the line being discussed, draw arrows for "name → object").
> - Each scene is one idea. Hold the final frame of each scene for 1 s so cuts feel natural.
>
> **Deliverable 2: `video.json`**, in exactly this format:
> ```json
> {
>   "title": "Python FastAPI - Video 1 - How Python Runs, Variables & Core Types",
>   "duration": <exact length of video.mp4 in seconds>,
>   "voice": "Holt",
>   "scenes": [
>     { "start": 0, "speech": "[slow pace] Welcome to video one ..." },
>     { "start": 23.8, "speech": "[slow pace] When you run python main dot py ..." }
>   ]
> }
> ```
> Rules:
> - `start` = the exact second (one decimal place) where that scene begins in the MP4. The first is 0, and the values go up.
> - `duration` = the MP4's real length, measured with ffprobe after rendering.
> - `speech` is the narration for that scene, starting with `[slow pace]`. Keep it under 800 characters, and size it to fit the scene: about 2.3 words per second (a 24 s scene ≈ 55 words).
> - Write for the ear: spell out symbols ("python main dot py", "double slash", "O of n squared") and don't use markdown or code in the speech.
>
> Produce the animation's scene timings from the same data you write to `video.json`, so they can't drift apart. At the end, print a table (scene, start, length, words) and give me both files to download.

**Check before moving on:**
- Play the MP4 and confirm the scene changes happen at the `start` times.
- Make sure `duration` matches the MP4 length.

Here's a real example of the expected JSON: [an 18-scene, 8:06 video](vids-autopilot/README.md#input-file).

> Tip: ask for a short **3-scene test video** first. It's a cheap way to check the whole pipeline before you render the full tutorial.

## Step 2: Put the MP4 into Google Vids

1. Go to [vids.google.com](https://vids.google.com) and create a **blank video**.
2. Upload `video.mp4` and drag it onto the timeline, so the timeline has **one clip and one scene**.
3. Keep the timeline visible at the bottom of the window.

## Step 3: Install the extension (one time)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose the [`vids-autopilot/`](vids-autopilot/) folder.
3. Pin the extension, then **reload** the Vids tab.

## Step 4: Split the clip into scenes

1. In the Vids tab, click the **Vids Autopilot** icon.
2. Choose your **`video.json`**. The summary shows the scene count, the duration and the longest speech.
3. Click **Split scenes**.
   - Chrome shows a yellow *"started debugging this browser"* bar. That's expected: it's how the extension presses the real split shortcut. Don't click Cancel.
   - Calibrate runs first. It sets the zoom to 100% and measures the timeline. Then the extension seeks to each start time and splits there.
   - It checks every split, and logs lines like `[scene 7/18] split @2:30.0 → ok`.
4. The run ends with **`Split done: 18 scenes ✓`**.

Keep the window size the same while it runs. If it stops, fix the cause and click **Split scenes** again; finished splits are skipped.

## Step 5: Add the AI voiceovers

1. Select scene 1 and open the **AI voiceover** panel. Check that the voice is **Holt**.
2. In the extension popup, click **Fill voiceovers**. For each scene it:
   - opens the scene in the panel ("Scene n / 18");
   - types that scene's `speech` and checks the text;
   - clicks **Insert voiceover** and waits for the voiceover to finish generating.
3. At the end it checks the **All scenes** tab and lists any scene with no script or a "Voiceover outdated" badge.

Generation can take up to a minute per scene, so leave the tab in the foreground. To resume, set **Start from scene #**; finished scenes are skipped.

## Step 6: Review and export

1. Play the video through. If a voiceover runs longer than its scene, either:
   - shorten that scene's `speech` and re-insert it (tick **Overwrite existing** and start from that scene), or
   - lengthen the scene in Vids.
2. Add titles, music or branding in Vids if you want.
3. Export it with **File → Download (MP4)**, or share it from Vids.

---

## More detail

- How the extension works, the popup buttons, troubleshooting and limitations: [vids-autopilot/README.md](vids-autopilot/README.md).
- If Google changes the Vids UI, click **Inspect DOM** in the popup and paste the output to Claude Code to update [`vids-autopilot/config.js`](vids-autopilot/config.js).
