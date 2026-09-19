# Pedal-loop review

- Native canvas: 20x18; original four-color palette. The first frame exactly matches the approved forward-shifted logo. All head/body pixels remain fixed throughout the animation. No new spokes, textures, bobbing or background decorations.
- Eight clockwise pedal phases, 140 ms each, 1.12-second infinite loop. Opposite ankle positions maintain the same centre; every phase transition, including the last-to-first seam, moves at most one pixel per axis.
- Pass 1, contact sheet: contact/passing poses present; leg overlap is intentional when crossing. Found the duration setter affected only the selected frame. FIX: explicitly apply timing to all frames.
- Pass 2, decoded GIF: all eight frames, colors, alpha and duration match the source. Transparency disposal produces no old-frame trails. First frame remains byte-identical to the approved PNG.
- Pass 3, actual Chromium playback: 32 screenshots over 5.778 seconds, all eight poses observed, five loop seams crossed. Every captured frame matches a source frame at native resolution. Playback contact sheet inspected; body/rims remain stable and only the feet/legs move.
- Far eye/wing remain hidden in the unchanged side view; leg crossings are occlusion, not missing limbs. Flat colors, no lighting, shading or antialiasing. Exact integer 1x/8x/24x GIF exports and 1x PNG/spritesheet.
- SHIP for user review. Open preview.html in a browser so the GIF animates rather than appearing as a frame list in macOS Preview.
