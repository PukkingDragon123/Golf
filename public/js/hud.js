// =============================================================
// HUD — drives the DOM overlay defined in index.html (numbers, bars,
// banners, start/pause/over screens, touch buttons).
// =============================================================
import { STR } from '../strings.js';
import { CONFIG, POWERUPS } from './config.js';
import { fmt, IS_TOUCH } from './utils.js';

const $ = (id) => document.getElementById(id);

export class HUD {
  constructor() {
    this.el = {
      hud: $('hud'), score: $('score'), wave: $('wave'), best: $('best'),
      healthBar: $('health-bar'), ammo: $('ammo'),
      puExp: $('pu-explosive'), puMulti: $('pu-multiball'),
      powerWrap: $('power-wrap'), powerBar: $('power-bar'),
      banner: $('banner'), toast: $('toast'), msg: $('msg'),
      start: $('start'), pause: $('pause'), over: $('over'),
      overScore: $('over-score'), overWave: $('over-wave'),
      touch: $('touch'), mute: $('mute'),
    };
    this._bannerT = null; this._toastT = null; this._msgT = null;
    this._fillText();
    if (IS_TOUCH) document.body.classList.add('touch');
  }

  _fillText() {
    $('t-title').innerHTML = STR.title.replace(/Z\s*$/, '<span class="z">Z</span>');
    $('t-tagline').textContent = STR.tagline;
    $('t-blurb').textContent = STR.blurb;
    $('btn-play').textContent = IS_TOUCH ? STR.startTouch : STR.start;
    $('t-ctrl-head').textContent = IS_TOUCH ? STR.ctrlHeadTouch : STR.ctrlHeadDesktop;
    const lines = IS_TOUCH
      ? [STR.ctrlAimTouch, STR.ctrlPowerTouch, STR.ctrlDriveTouch]
      : [STR.ctrlAimDesktop, STR.ctrlPowerDesktop, STR.ctrlDriveDesktop, STR.ctrlPowerupDesktop];
    $('t-controls').innerHTML = lines.map((l) => `<li>${l}</li>`).join('') + `<li class="dim">${STR.ctrlGamepad}</li>`;
    $('btn-resume').textContent = STR.resume;
    $('btn-restart').textContent = STR.restart;
    $('t-pause').textContent = STR.paused;
    $('t-over').textContent = STR.gameOver;
    $('t-over-sub').textContent = STR.gameOverSub;
    $('lbl-score').textContent = STR.hudScore;
    $('lbl-wave').textContent = STR.hudWave;
    $('lbl-best').textContent = STR.hudBest;
    $('lbl-health').textContent = STR.hudHealth;
    $('lbl-final').textContent = STR.finalScore;
    $('lbl-reached').textContent = STR.reached;
    $('btn-swing').textContent = STR.swing;
    $('btn-item').textContent = STR.item;
  }

  setCallbacks({ start, resume, restart, mute }) {
    $('btn-play').onclick = start;
    $('btn-resume').onclick = resume;
    $('btn-restart').onclick = restart;
    this.el.mute.onclick = mute;
  }

  // wire the touch SWING/ITEM buttons to the input layer
  wireTouch(input) {
    const sw = $('btn-swing'), it = $('btn-item');
    const press = (e) => { e.preventDefault(); input.touchCharge(true); sw.classList.add('active'); };
    const rel = (e) => { e.preventDefault(); input.touchCharge(false); sw.classList.remove('active'); };
    sw.addEventListener('touchstart', press, { passive: false });
    sw.addEventListener('touchend', rel, { passive: false });
    sw.addEventListener('touchcancel', rel, { passive: false });
    it.addEventListener('touchstart', (e) => { e.preventDefault(); input.touchItem(); }, { passive: false });
    // also support mouse for desktop testing of touch buttons
    sw.addEventListener('mousedown', press); sw.addEventListener('mouseup', rel);
    it.addEventListener('click', () => input.touchItem());
  }

  showStart() { this._only('start'); }
  showPause() { this.el.pause.classList.add('on'); }
  hidePause() { this.el.pause.classList.remove('on'); }
  showGameOver(score, wave) {
    this.el.overScore.textContent = fmt(score);
    this.el.overWave.textContent = wave;
    this._only('over');
  }
  startPlaying() {
    this.el.start.classList.remove('on');
    this.el.over.classList.remove('on');
    this.el.pause.classList.remove('on');
    this.el.hud.classList.add('on');
  }
  _only(which) {
    this.el.hud.classList.remove('on');
    for (const k of ['start', 'pause', 'over']) this.el[k].classList.toggle('on', k === which);
  }

  banner(text, sub = '', surge = false) {
    const b = this.el.banner;
    b.innerHTML = `<div class="big ${surge ? 'surge' : ''}">${text}</div>${sub ? `<div class="sub">${sub}</div>` : ''}`;
    b.classList.remove('show'); void b.offsetWidth; b.classList.add('show');
    clearTimeout(this._bannerT);
    this._bannerT = setTimeout(() => b.classList.remove('show'), 2200);
  }
  toast(text, color = '#ffd34d') {
    const t = this.el.toast;
    t.textContent = text; t.style.color = color;
    t.classList.remove('show'); void t.offsetWidth; t.classList.add('show');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => t.classList.remove('show'), 1500);
  }
  flashMsg(text) {
    const m = this.el.msg; m.textContent = text;
    m.classList.remove('show'); void m.offsetWidth; m.classList.add('show');
    clearTimeout(this._msgT);
    this._msgT = setTimeout(() => m.classList.remove('show'), 1200);
  }
  setMuted(m) { this.el.mute.textContent = m ? '🔇' : '🔊'; }

  update(s) {
    this.el.score.textContent = fmt(s.score);
    this.el.wave.textContent = s.wave;
    this.el.best.textContent = fmt(s.best);
    const hp = Math.max(0, s.health) / CONFIG.startHealth * 100;
    this.el.healthBar.style.width = hp + '%';
    this.el.healthBar.style.background = hp > 50
      ? 'linear-gradient(90deg,#4dff7a,#9cff5a)'
      : hp > 25 ? 'linear-gradient(90deg,#ffc23a,#ff8a3a)' : 'linear-gradient(90deg,#ff5a3a,#ff2a2a)';
    this.el.ammo.textContent = `${STR.hudAmmo} ${s.ammo}`;
    this.el.ammo.classList.toggle('low', s.ammo <= 3);

    this.el.puExp.style.display = s.explosive > 0 ? '' : 'none';
    this.el.puExp.textContent = `${POWERUPS.explosive.icon} ${s.explosive}`;
    this.el.puExp.classList.toggle('armed', s.armed === 'explosive');
    this.el.puMulti.style.display = s.multiball > 0 ? '' : 'none';
    this.el.puMulti.textContent = `${POWERUPS.multiball.icon} ${s.multiball}`;
    this.el.puMulti.classList.toggle('armed', s.armed === 'multiball');

    if (s.charging) {
      this.el.powerWrap.classList.add('on');
      this.el.powerBar.style.height = s.power + '%';
    } else this.el.powerWrap.classList.remove('on');
  }
}
