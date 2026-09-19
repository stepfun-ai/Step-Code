# Riding-relationship review

## Iterations before opening the PNG

1. 24x20 trial: rider moved forward, but long leg strokes obscured the frame triangle. FIX: change leg bend and seat/frame spacing.
2. Lowered 24x20 trial: contact points were present, but the small triangle interior was crowded by feet. FIX: add two vertical rows rather than stretching the wheelbase again; fold the near leg behind the seat tube.
3. 24x22 final: enlarged and 4x previews inspected. Small open triangle visible, feet oppose the crank, saddle supports the body, wing reaches handlebar. SHIP for user review. A validation initially included an edge pixel as an interior pixel; inspecting the actual raster confirmed the triangular opening is (14,15), (15,15), (14,16), and the assertion was corrected.

## User criteria

- Saddle supports rump: body at (8,12) and (9,12) directly rests on visible saddle pixels (8,13) and (9,13). The rump is forward of the rear hub, not seated on the tire.
- Pedals between wheels: rear/front hubs are (4,18)/(19,18); crank is (12,18). Yellow foot contacts are (11,19)/(13,17), exactly opposite around that crank. Near leg folds back and far leg folds forward; the feet do not merge.
- Simplified frame: exactly one frame triangle, rear chain stay, short front fork, and two rims. No full-width rectangular double rail or decorative wheel spokes. Part of the triangle is intentionally occluded by the far leg; a triangular negative-space opening remains visible.
- Rider forward: head centre is ahead of lower-torso centre. Near wing ends at (16,12), contacting handlebar at (17,12). Far wing/eye intentionally hidden by side view.
- Preserve mascot: purple rounded head, single eye with glint, yellow throat pouch and lowered tail. Bike uses a quieter purple to distinguish saddle/frame from the bird without adding outlines.

## Craft and export

- Five flat opaque colors; no shading, gradients, outline or antialiasing. Lighting/ramp/animation criteria not applicable.
- Value contrast separates bird and frame from the dark background. No near-duplicate colors. Isolated pixels are diagonal rim steps and one diagonal frame segment, not stray marks.
- Native 24x22 and exact integer 8x, 24x, 32x exports. Both enlarged and small 4x previews inspected before opening the final image.
- Build assertions passed: dimensions, saddle/body contact, foot/crank symmetry, anchor ordering, wing/handlebar contact, visible triangle interior, binary alpha.
