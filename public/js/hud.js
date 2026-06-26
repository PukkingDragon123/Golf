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
      hud: $('hud'), score: $('score'), wave: $('wave'), best: $('best'), survivors: $('survivors'),
      healthBar: $('health-bar'), ammo: $('ammo'),
      puExp: $('pu-explosive'), puMulti: $('pu-multiball'),
      powerWrap: $('power-wrap'), powerBar: $('power-bar'),
      banner: $('banner'), toast: $('toast'), msg: $('msg'),
      start: $('start'), pause: $('pause'), over: $('over'),
      overScore: $('over-score'), overWave: $('over-wave'),
      touch: $('touch'), mute: $('mute'),
      clubName: $('club-name'), spinMode: $('spin-mode'), windArrow: $('wind-arrow'), windStr: $('wind-str'),
      cartWrap: $('cart-wrap'), cartBar: $('cart-bar'), boostBar: $('boost-bar'), integrityBar: $('integrity-bar'),
      vignette: $('vignette'), build: $('build'), buildPost: $('build-post'), buildTypes: $('build-types'), buildStatus: $('build-status'),
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
      ? [STR.ctrlAimTouch, STR.ctrlPowerTouch, STR.ctrlDriveTouch, STR.ctrlClubTouch, STR.ctrlBoostTouch, STR.ctrlBuildTouch]
      : [STR.ctrlAimDesktop, STR.ctrlPowerDesktop, STR.ctrlDriveDesktop, STR.ctrlPowerupDesktop, STR.ctrlClubDesktop, STR.ctrlBoostDesktop, STR.ctrlBuildDesktop];
    const lblSurv = $('lbl-survivors'); if (lblSurv) lblSurv.textContent = STR.hudSurvivors;
    const lblCart = $('lbl-cart'); if (lblCart) lblCart.textContent = STR.hudCart;
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

    const tap = (id, fn) => { const e = $(id); if (!e) return; e.addEventListener('touchstart', (ev) => { ev.preventDefault(); fn(); }, { passive: false }); e.addEventListener('click', fn); };
    tap('btn-club', () => input.touchClub());
    tap('btn-spin', () => input.touchSpin());
    tap('btn-build', () => input.touchBuild());
    const bo = $('btn-boost');
    if (bo) {
      const bp = (e) => { e.preventDefault(); input.touchBoost(true); bo.classList.add('active'); };
      const br = (e) => { e.preventDefault(); input.touchBoost(false); bo.classList.remove('active'); };
      bo.addEventListener('touchstart', bp, { passive: false }); bo.addEventListener('touchend', br, { passive: false });
      bo.addEventListener('touchcancel', br, { passive: false });
      bo.addEventListener('mousedown', bp); bo.addEventListener('mouseup', br);
    }
    tap('build-prev', () => input.handlers.buildCycle?.(-1));
    tap('build-next', () => input.handlers.buildCycle?.(1));
    if (this.el.buildTypes) this.el.buildTypes.addEventListener('click', (e) => {
      const c = e.target.closest('.build-chip'); if (c) input.handlers.buildPick?.(+c.dataset.i);
    });
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

    if (this.el.survivors) this.el.survivors.textContent = s.survivors ?? 0;

    if (s.club && this.el.clubName) {
      this.el.clubName.textContent = `${s.clubIcon} ${s.club}`;
      const sm = s.spin === 'back' ? STR.spinBack : s.spin === 'top' ? STR.spinTop : STR.spinNeutral;
      this.el.spinMode.textContent = sm;
      this.el.spinMode.style.color = s.spin === 'back' ? '#ff8a3a' : s.spin === 'top' ? '#39b6ff' : '#cabba8';
    }
    if (s.wind && this.el.windArrow) {
      this.el.windArrow.style.transform = `rotate(${s.wind.angle * 180 / Math.PI}deg)`;
      const mag = s.wind.mag;
      this.el.windStr.textContent = mag < 0.5 ? 'CALM' : Math.round(mag) + ' m/s';
      this.el.windArrow.style.borderBottomColor = mag > 4 ? '#ff7a1a' : mag > 2 ? '#ffd34d' : '#ffd9a0';
    }
    if (s.cartHealth !== undefined && this.el.cartWrap) {
      this.el.cartWrap.classList.add('on');
      const ch = Math.max(0, s.cartHealth) / CONFIG.cartHealth * 100;
      this.el.cartBar.style.width = ch + '%';
      this.el.cartBar.style.background = ch > 40 ? 'linear-gradient(90deg,#9cd6ff,#4cc6ff)' : 'linear-gradient(90deg,#ff8a3a,#ff3a2a)';
      this.el.boostBar.style.width = ((s.boost || 0) * 100) + '%';
      this.el.vignette.classList.toggle('hurt', !!s.damage);
    } else if (this.el.cartWrap) this.el.cartWrap.classList.remove('on');
    if (s.buildInfo) { this.el.integrityBar.style.width = (s.buildInfo.integrity * 100) + '%'; this.updateBuild(s); }
  }

  updateBuild(s) {
    const b = s.buildInfo; if (!b || !this.el.build) return;
    this.el.build.classList.toggle('on', !!s.buildMode);
    if (!s.buildMode) return;
    this.el.buildPost.textContent = b.postLabel || 'POST';
    if (b.options) {
      this.el.buildTypes.innerHTML = b.options.map((o, i) =>
        `<span class="build-chip ${o.sel ? 'sel' : ''} ${o.affordable ? '' : 'disabled'}" data-i="${i}">${o.label}</span>`).join('');
    }
    this.el.buildStatus.textContent = b.status || '';
  }
}
