// Bundled sample project. Tests, comparison, and export all use this same data.
export const ASSETS = [
  { id: 'frame-skyline', name: 'skyline-dusk.svg', type: 'FRAME', meta: '800 × 450 · bundled SVG', rightsStatus: 'cleared', rightsLabel: 'Original procedural illustration', tone: 'violet', image: 'assets/skyline.svg', note: 'Bundled illustration / no external source' },
  { id: 'frame-window', name: 'window-light.svg', type: 'FRAME', meta: '800 × 450 · bundled SVG', rightsStatus: 'cleared', rightsLabel: 'Original procedural illustration', tone: 'amber', image: 'assets/window.svg', note: 'Bundled illustration / no external source' },
  { id: 'frame-hands', name: 'hands-on-glass.svg', type: 'FRAME', meta: '800 × 450 · bundled SVG', rightsStatus: 'editorial', rightsLabel: 'Editorial study · review', tone: 'blue', image: 'assets/hands.svg', note: 'Bundled illustration / internal review label' },
  { id: 'frame-rooftop', name: 'rooftop-static.svg', type: 'FRAME', meta: '800 × 450 · bundled SVG', rightsStatus: 'ai-assisted', rightsLabel: 'AI-assisted · cleared', tone: 'green', image: 'assets/rooftop.svg', note: 'Bundled illustration / source note retained' },
  { id: 'audio-hum', name: 'signal-hum.wav', type: 'AUDIO', meta: '48 kHz · 00:22 · metadata only', rightsStatus: 'cleared', rightsLabel: 'Original', tone: 'pink', note: 'Sample sound-design cue / no audio file bundled' },
  { id: 'audio-voice', name: 'voice-note-07.wav', type: 'AUDIO', meta: '48 kHz · 00:41 · metadata only', rightsStatus: 'cleared', rightsLabel: 'Voice release on file', tone: 'orange', note: 'Sample narration cue / no audio file bundled' },
];

export const CREDITS = [
  { id: 'credit-rae-biko', name: 'Rae Biko', role: 'Direction + edit' },
  { id: 'credit-samir-vale', name: 'Samir Vale', role: 'Voice' },
  { id: 'credit-mina-okafor', name: 'Mina Okafor', role: 'Sound design' },
  { id: 'credit-frame-room-04', name: 'Frame room 04', role: 'Production' },
];

export const CUTS = {
  quiet: {
    label: 'Quiet Signal',
    duration: 198,
    scenes: [
      { id: 's01', number: '01', title: 'The city holds its breath', description: 'A wide city edge, after the noise has gone.', start: 0, end: 34, assetId: 'frame-skyline', cue: 'signal-hum', cueLabel: 'Low hum / fade in', cueTime: '00:00', continuity: 'match', color: 'violet' },
      { id: 's02', number: '02', title: 'A light in the west', description: 'One apartment stays awake above the avenue.', start: 34, end: 76, assetId: 'frame-window', cue: 'signal-hum', cueLabel: 'Room tone / -18 dB', cueTime: '00:34', continuity: 'match', color: 'amber' },
      { id: 's03', number: '03', title: 'Listen before you look', description: 'The voice arrives through the glass.', start: 76, end: 119, assetId: 'frame-hands', cue: 'voice-note-07', cueLabel: 'Voice note / take 07', cueTime: '01:16', continuity: 'watch', color: 'blue' },
      { id: 's04', number: '04', title: 'Static becomes weather', description: 'A roofline dissolves into an electrical sky.', start: 119, end: 161, assetId: 'frame-rooftop', cue: 'signal-hum', cueLabel: 'Hum rises / -12 dB', cueTime: '01:59', continuity: 'match', color: 'green' },
      { id: 's05', number: '05', title: 'The last signal', description: 'The frame goes dark. Something remains.', start: 161, end: 198, assetId: 'frame-skyline', cue: 'voice-note-07', cueLabel: 'Tail / hold 2 sec', cueTime: '02:41', continuity: 'match', color: 'violet' },
    ],
  },
  pulse: {
    label: 'Pulse Edit',
    duration: 162,
    scenes: [
      { id: 'p01', number: '01', title: 'The city holds its breath', description: 'A wide city edge, after the noise has gone.', start: 0, end: 22, assetId: 'frame-skyline', cue: 'signal-hum', cueLabel: 'Low hum / hard in', cueTime: '00:00', continuity: 'match', color: 'violet' },
      { id: 'p02', number: '02', title: 'Static becomes weather', description: 'A roofline dissolves into an electrical sky.', start: 22, end: 57, assetId: 'frame-rooftop', cue: 'signal-hum', cueLabel: 'Hum pulse / -12 dB', cueTime: '00:22', continuity: 'watch', color: 'green' },
      { id: 'p03', number: '03', title: 'Listen before you look', description: 'The voice arrives through the glass.', start: 57, end: 101, assetId: 'frame-hands', cue: 'voice-note-07', cueLabel: 'Voice note / take 07', cueTime: '00:57', continuity: 'match', color: 'blue' },
      { id: 'p04', number: '04', title: 'A light in the west', description: 'One apartment stays awake above the avenue.', start: 101, end: 132, assetId: 'frame-window', cue: 'signal-hum', cueLabel: 'Room tone / -14 dB', cueTime: '01:41', continuity: 'match', color: 'amber' },
      { id: 'p05', number: '05', title: 'The last signal', description: 'The frame goes dark. Something remains.', start: 132, end: 162, assetId: 'frame-skyline', cue: 'voice-note-07', cueLabel: 'Tail / hold 1 sec', cueTime: '02:12', continuity: 'match', color: 'violet' },
    ],
  },
};
