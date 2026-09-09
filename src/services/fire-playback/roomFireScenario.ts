// Native camera bookmarks from fire_scenarios_batch/renders/cameras/*.json,
// transformed from source XYZ to viewer (x,z,-y). Only used on explicit focus.
export const ROOM_FIRE_VIEWS: Record<string, { position: [number, number, number]; target: [number, number, number] }> = {
  table_high: { position: [5.733851, 1.2, 3.393766], target: [2.918893, .612, 3.393766] },
  sofa_high: { position: [6.147518, 1.2, 2.668794], target: [9.347518, .663349, 2.668794] },
  curtain_high: { position: [8.609968, 2.4, 1.200738], target: [8.609968, 3.020080, -1.999262] },
}
