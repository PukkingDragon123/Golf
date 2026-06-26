// Solo, client-side real-time game: all simulation runs in the browser
// (index.html). The platform still requires a rules module at the zip root;
// this is the canonical solo stub.
export const meta = { game: 'golf-z', minPlayers: 1, maxPlayers: 1 };
export function setup() { return {}; }
export function validateAction() { return { ok: true }; }
export function applyAction(state) { return state; }
export function isGameOver() { return { over: false }; }
export function viewFor(state) { return state; }
