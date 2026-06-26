// =============================================================
// Input — keyboard (physical key codes), mouse + pointer lock, touch
// (virtual stick + drag-aim + buttons), and gamepad. All map to the same
// drive / aim / fire / item / pause commands.
// =============================================================
import { CONFIG } from './config.js';
import { clamp } from './utils.js';

const DRIVE = { KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right' };
const AIMK = { ArrowLeft: 'aleft', ArrowRight: 'aright', ArrowUp: 'aup', ArrowDown: 'adown' };
const KEY_AIM_SPEED = 1.9;

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.held = new Set();
    this.mdx = 0; this.mdy = 0;          // mouse delta accumulator
    this.tdx = 0; this.tdy = 0;          // touch aim delta accumulator
    this.touchDrive = null;              // {ox,oy,x,y,id} active joystick
    this.aimTouchId = null;
    this.locked = false;
    this.enabled = false;                // only steer/aim while playing
    this.handlers = {};
    this.drive = { throttle: 0, steer: 0 };
    this.aim = { dyaw: 0, dpitch: 0 };
    this._padCharge = false; this._padA = false; this._padStart = false;

    addEventListener('keydown', (e) => this._key(e, true));
    addEventListener('keyup', (e) => this._key(e, false));
    document.addEventListener('mousemove', (e) => {
      if (this.locked) { this.mdx += e.movementX; this.mdy += e.movementY; }
    });
    document.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (this.locked) { if (e.button === 0) this._fire(true); }
      else this.requestLock();
    });
    document.addEventListener('mouseup', (e) => { if (this.locked && e.button === 0) this._fire(false); });
    document.addEventListener('pointerlockchange', () => {
      this.locked = (document.pointerLockElement === canvas);
      if (!this.locked && this.enabled && this.handlers.pause) this.handlers.pause();
    });

    // touch
    addEventListener('touchstart', (e) => this._touch(e, 'start'), { passive: false });
    addEventListener('touchmove', (e) => this._touch(e, 'move'), { passive: false });
    addEventListener('touchend', (e) => this._touch(e, 'end'), { passive: false });
    addEventListener('touchcancel', (e) => this._touch(e, 'end'), { passive: false });
  }

  setHandlers(h) { this.handlers = h; }
  requestLock() { if (this.canvas.requestPointerLock) this.canvas.requestPointerLock(); }
  _fire(down) { if (down) this.handlers.chargeStart?.(); else this.handlers.chargeEnd?.(); }

  _key(e, down) {
    if (DRIVE[e.code] || AIMK[e.code] || e.code === 'Space') e.preventDefault();
    if (down && this.held.has(e.code)) return; // ignore auto-repeat for edges
    if (down) this.held.add(e.code); else this.held.delete(e.code);
    if (!this.enabled) return;
    if (e.code === 'Space') this._fire(down);
    if (down && (e.code === 'KeyQ' || e.code === 'KeyE')) this.handlers.useItem?.();
    if (down && (e.code === 'KeyP' || e.code === 'Escape')) this.handlers.pause?.();
    if (down && e.code === 'KeyM') this.handlers.mute?.();
    if (down && e.code === 'KeyC') this.handlers.cycleClub?.();
    if (down && e.code === 'KeyV') this.handlers.cycleSpin?.();
    if (down && e.code === 'KeyG') this.handlers.buyWeapon?.();
    if (down && e.code === 'KeyF') this.handlers.cartAction?.();
    if (down && e.code === 'KeyR') this.handlers.toRoof?.();
    if (down && (e.code === 'KeyB' || e.code === 'Tab')) this.handlers.buildToggle?.();
    if (down && e.code === 'BracketLeft') this.handlers.buildCycle?.(-1);
    if (down && e.code === 'BracketRight') this.handlers.buildCycle?.(1);
    if (down && e.code === 'Enter') this.handlers.buildConfirm?.();
    if (down && e.code === 'KeyX') this.handlers.buildSell?.();
  }

  // SWING / ITEM / CLUB / SPIN / BOOST on-screen buttons call these
  touchCharge(down) { this._fire(down); }
  touchItem() { this.handlers.useItem?.(); }
  touchClub() { this.handlers.cycleClub?.(); }
  touchSpin() { this.handlers.cycleSpin?.(); }
  touchBuyWeapon() { this.handlers.buyWeapon?.(); }
  touchCart() { this.handlers.cartAction?.(); }
  touchBoost(down) { this._touchBoost = down; }
  touchBuild() { this.handlers.buildToggle?.(); }

  _touch(e, phase) {
    if (!this.enabled) return;
    if (e.target && e.target.closest && e.target.closest('.ui-btn')) return; // buttons handle themselves
    e.preventDefault();
    const W = innerWidth;
    for (const t of e.changedTouches) {
      const leftSide = t.clientX < W * 0.45;
      if (phase === 'start') {
        if (leftSide && !this.touchDrive) this.touchDrive = { ox: t.clientX, oy: t.clientY, x: 0, y: 0, id: t.identifier };
        else if (!leftSide && this.aimTouchId === null) { this.aimTouchId = t.identifier; this._ax = t.clientX; this._ay = t.clientY; }
      } else if (phase === 'move') {
        if (this.touchDrive && t.identifier === this.touchDrive.id) {
          this.touchDrive.x = clamp((t.clientX - this.touchDrive.ox) / 60, -1, 1);
          this.touchDrive.y = clamp((t.clientY - this.touchDrive.oy) / 60, -1, 1);
        } else if (t.identifier === this.aimTouchId) {
          this.tdx += (t.clientX - this._ax) * 2.0; this.tdy += (t.clientY - this._ay) * 2.0;
          this._ax = t.clientX; this._ay = t.clientY;
        }
      } else { // end
        if (this.touchDrive && t.identifier === this.touchDrive.id) this.touchDrive = null;
        if (t.identifier === this.aimTouchId) this.aimTouchId = null;
      }
    }
  }

  _gamepad(dt) {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let gp = null;
    for (const p of pads) if (p) { gp = p; break; }
    if (!gp) return;
    const dz = (v) => (Math.abs(v) < 0.16 ? 0 : v);
    this.drive.throttle += -dz(gp.axes[1] || 0);
    this.drive.steer += dz(gp.axes[0] || 0);
    this.aim.dyaw += dz(gp.axes[2] || 0) * CONFIG.padAimSpeed * dt;
    this.aim.dpitch += dz(gp.axes[3] || 0) * CONFIG.padAimSpeed * dt;
    const rt = gp.buttons[7] && gp.buttons[7].pressed;
    if (rt !== this._padCharge) { this._padCharge = rt; this._fire(rt); }
    const a = gp.buttons[0] && gp.buttons[0].pressed;
    if (a && !this._padA) this.handlers.useItem?.();
    this._padA = a;
    const st = gp.buttons[9] && gp.buttons[9].pressed;
    if (st && !this._padStart) this.handlers.pause?.();
    this._padStart = st;
    const lb = gp.buttons[4] && gp.buttons[4].pressed;
    if (lb && !this._padLB) this.handlers.cycleClub?.(); this._padLB = lb;
    const du = gp.buttons[12] && gp.buttons[12].pressed;
    if (du && !this._padDU) this.handlers.cycleSpin?.(); this._padDU = du;
    const y = gp.buttons[3] && gp.buttons[3].pressed;
    if (y && !this._padY) this.handlers.buildToggle?.(); this._padY = y;
    const xb = gp.buttons[2] && gp.buttons[2].pressed;
    if (xb && !this._padX) this.handlers.cartAction?.(); this._padX = xb;
    const dd = gp.buttons[13] && gp.buttons[13].pressed;
    if (dd && !this._padDD) this.handlers.toRoof?.(); this._padDD = dd;
    if (gp.buttons[6] && gp.buttons[6].pressed) this.drive.boost = true; // LT
  }

  // call once per frame; fills this.drive and this.aim
  update(dt) {
    let throttle = 0, steer = 0;
    if (this.held.has('KeyW')) throttle += 1;
    if (this.held.has('KeyS')) throttle -= 1;
    if (this.held.has('KeyA')) steer -= 1;
    if (this.held.has('KeyD')) steer += 1;

    let dyaw = 0, dpitch = 0;
    if (this.held.has('ArrowRight')) dyaw += KEY_AIM_SPEED * dt;
    if (this.held.has('ArrowLeft')) dyaw -= KEY_AIM_SPEED * dt;
    if (this.held.has('ArrowUp')) dpitch -= KEY_AIM_SPEED * dt;
    if (this.held.has('ArrowDown')) dpitch += KEY_AIM_SPEED * dt;

    dyaw += this.mdx * CONFIG.yawSensitivity + this.tdx * CONFIG.yawSensitivity;
    dpitch += this.mdy * CONFIG.pitchSensitivity + this.tdy * CONFIG.pitchSensitivity;
    this.mdx = this.mdy = this.tdx = this.tdy = 0;

    if (this.touchDrive) { throttle += -this.touchDrive.y; steer += this.touchDrive.x; }

    this.drive.throttle = clamp(throttle, -1, 1);
    this.drive.steer = clamp(steer, -1, 1);
    this.drive.boost = this.held.has('ShiftLeft') || this.held.has('ShiftRight') || !!this._touchBoost;
    this.aim.dyaw = dyaw; this.aim.dpitch = dpitch;
    this._gamepad(dt);
    this.drive.throttle = clamp(this.drive.throttle, -1, 1);
    this.drive.steer = clamp(this.drive.steer, -1, 1);
  }
}
