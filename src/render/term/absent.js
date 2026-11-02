// What a status-line slot or token shows when its data does not exist: a visible em dash,
// never ''. hud.js says why (an empty slot pulls the slots below it up). It lives here, alone,
// so the stage path, which runs on every poll, can name it without loading the HUD.
export const ABSENT = '—';  // — this slot's data does not exist
