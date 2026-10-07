// All selectors, labels and timing constants for Vids Autopilot.
// Loaded before content.js via the manifest; exposed as window.CFG.
// Edit this file after running "Inspect DOM" if Vids changes its UI.
window.CFG = {
  // --- Timeline ---
  zoomLabel: '100%',
  // Zoom toolbar (verified Oct 2026): a combobox whose text <input> holds the value ("300%"),
  // plus a slider with aria-valuetext "300%". The dropdown lists 5%..800% and "Fit".
  zoomInputSel: 'input[aria-label="Set timeline zoom"]',
  zoomSliderSel: '[role="slider"][aria-label="Adjust timeline zoom"]',
  zoomToolbarSel: '[role="toolbar"][aria-label="Timeline zoom controls"]',
  timerSel: '[role="timer"]',             // "01:17.0/08:06.4"
  playheadSel: '[role="time"]',           // "Playhead at 23 seconds out of ..."
  sceneLabelRe: /^Scene (\d+) of (\d+)$/,
  scrollerMinScrollWidth: 20000,
  defaultGapPx: 18.4,
  minPxPerSec: 10,                        // below this the timeline is zoomed out too far to seek
  seekTolerance: 0.15,                    // seconds
  splitVerifyTolerance: 0.5,              // seconds: new scene must start this close to T
  rulerProbeOffsets: [0, -10, 10],        // px tried around the detected ruler Y
  rulerAboveThumbsPx: 20,                 // fallback: ruler is this far above scene row
  retries: 3,
  playheadAvoidPx: 30,                    // a seek click this close to the playhead hits its handle…
  playheadParkPx: 150,                    // …so park the playhead this far away first
  sceneClickOffsetPx: 12,                 // select a scene by clicking this far inside its left edge

  // --- Timing (ms) ---
  delays: {
    afterScroll: 900,                     // minimum settle after setting scrollLeft
    afterSplit: 1200,
    afterClick: 400,
    afterZoom: 800,
    afterDebuggerAttach: 1200,            // let the debugging banner settle the layout
    typing: 300
  },
  waitFor: { timeout: 5000, interval: 100 },
  splitWaitMs: 5000,

  // --- Voiceover: "AI voiceover" sidebar (verified Oct 2026) ---
  voiceover: {
    sidebarSel: '[role="complementary"][aria-label="AI voiceover"]',
    panelButtonText: ['AI voiceover', 'Voiceover'],   // button that opens the sidebar
    currentSceneTab: 'Current scene',
    allScenesTab: 'All scenes',
    sceneLabelRe: /^Scene (\d+) \/ (\d+)$/,          // "Scene 1 / 18" in the sidebar
    nextLabel: 'Next script',
    prevLabel: 'Previous script',
    scriptBoxSel: '[role="form"][aria-label="Scripts"]', // canvas/SVG editor; text lives in <text> nodes
    placeholder: "Enter a script, or type '[' to view audio tags",
    counterRe: /^([\d,]+)\s*\/\s*[\d,]+$/,              // "348/2,500"
    voiceName: 'Holt',
    changeVoiceLabel: 'Change the voice',
    voiceConfirmText: ['Select', 'Done', 'Apply', 'Save'],
    insertLabel: 'Insert voiceover',
    outdatedText: 'Voiceover outdated',
    emptyCardText: 'Add your script',
    progressText: 'This might take a few minutes',
    startTimeoutMs: 15000,                // insert must show progress (or finish) within this
    waitClipTimeoutMs: 180000,            // generation can take minutes
    moreActionsLabel: 'More actions',
    updateAllText: ['Update all voiceovers'],
    replaceText: ['Replace']
  },

  // --- Split ---
  split: { useDebuggerKey: true, menuTextFallback: ['Split', 'Split scene', 'Split at playhead'] },

  // --- Inspect DOM ---
  inspectRoles: ['button', 'textbox', 'combobox', 'menuitem', 'option', 'dialog', 'listbox', 'tab', 'menu'],

  logBufferSize: 500
};
