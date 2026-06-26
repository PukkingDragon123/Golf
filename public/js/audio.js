// =============================================================
// Procedural audio — synthesized with the Web Audio API (no asset files).
// Swing, explosion, impact, pickup, zombie groans + a tense ambient bed.
// =============================================================

export class AudioKit {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.sfxGain = null;
    this.musicGain = null;
    this.noiseBuf = null;
    this.muted = false;
    this.musicNodes = null;
    this._lastGroan = 0;
  }

  // Must be called from a user gesture (click/tap/key) to satisfy autoplay rules.
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(ctx.destination);
    this.sfxGain = ctx.createGain();
    this.sfxGain.gain.value = 0.55;
    this.sfxGain.connect(this.master);
    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = 0.0;
    this.musicGain.connect(this.master);

    // 2s of reusable white noise
    const n = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
  }

  get t() { return this.ctx ? this.ctx.currentTime : 0; }

  _noise(dur, { type = 'lowpass', freq = 1200, q = 1, gain = 0.5, decay = 0.2 } = {}) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = this.t;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const filt = ctx.createBiquadFilter();
    filt.type = type; filt.frequency.value = freq; filt.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    src.connect(filt).connect(g).connect(this.sfxGain);
    src.start(t); src.stop(t + dur);
    return { src, filt, g };
  }

  _tone(freq, dur, { type = 'sine', gain = 0.3, slideTo = null, attack = 0.005 } = {}) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = this.t;
    const o = ctx.createOscillator();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.sfxGain);
    o.start(t); o.stop(t + dur + 0.02);
  }

  // crisp club thwack + air whoosh, scaled by shot power (0..1)
  swing(power = 0.7) {
    if (!this.ctx) return;
    this._noise(0.18, { type: 'highpass', freq: 600 + power * 1400, gain: 0.25 + power * 0.3, decay: 0.16 });
    this._tone(180 + power * 120, 0.09, { type: 'triangle', gain: 0.32, slideTo: 90, attack: 0.002 });
  }

  explosion() {
    if (!this.ctx) return;
    this._noise(0.7, { type: 'lowpass', freq: 900, q: 0.7, gain: 0.85, decay: 0.6 });
    this._tone(120, 0.6, { type: 'sine', gain: 0.6, slideTo: 38, attack: 0.004 });
    this._tone(70, 0.5, { type: 'square', gain: 0.18, slideTo: 30 });
  }

  hit() {
    if (!this.ctx) return;
    this._noise(0.14, { type: 'lowpass', freq: 500, gain: 0.4, decay: 0.12 });
    this._tone(150, 0.12, { type: 'sine', gain: 0.3, slideTo: 70, attack: 0.002 });
  }

  pickup() {
    if (!this.ctx) return;
    const base = 520;
    [0, 0.07, 0.14].forEach((d, i) => {
      setTimeout(() => this._tone(base * Math.pow(1.26, i), 0.18, { type: 'triangle', gain: 0.3 }), d * 1000);
    });
  }

  // gravelly low groan, rate-limited so the horde doesn't drone constantly
  groan() {
    if (!this.ctx) return;
    const now = performance.now();
    if (now - this._lastGroan < 700) return;
    this._lastGroan = now;
    const f = 70 + Math.random() * 40;
    this._tone(f, 0.5, { type: 'sawtooth', gain: 0.12, slideTo: f * 0.7, attack: 0.05 });
  }

  waveAlert(surge = false) {
    if (!this.ctx) return;
    this._tone(surge ? 330 : 294, 0.2, { type: 'sawtooth', gain: 0.22 });
    setTimeout(() => this._tone(surge ? 247 : 392, 0.32, { type: 'sawtooth', gain: 0.22 }), 180);
  }

  // Tense ambient bed: detuned drone + slow filter sweep + low heartbeat pulse.
  startMusic() {
    if (!this.ctx || this.musicNodes) return;
    const ctx = this.ctx, t = this.t;
    const out = this.musicGain;
    out.gain.cancelScheduledValues(t);
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(this.muted ? 0.0001 : 0.16, t + 3);

    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass'; filt.frequency.value = 280; filt.Q.value = 3;
    filt.connect(out);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.05;
    const lfoG = ctx.createGain(); lfoG.gain.value = 160;
    lfo.connect(lfoG).connect(filt.frequency); lfo.start();

    const drone = [55, 55.4, 82.5].map((f) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = f;
      const g = ctx.createGain(); g.gain.value = 0.14;
      o.connect(g).connect(filt); o.start();
      return o;
    });

    // low heartbeat pulse every ~2s
    const pulse = setInterval(() => {
      if (!this.ctx) return;
      const tt = this.t;
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 48;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, tt);
      g.gain.exponentialRampToValueAtTime(0.5, tt + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.5);
      o.connect(g).connect(out); o.start(tt); o.stop(tt + 0.55);
    }, 2000);

    this.musicNodes = { lfo, drone, pulse };
  }

  setMuted(m) {
    this.muted = m;
    if (this.musicGain && this.ctx) {
      this.musicGain.gain.setTargetAtTime(m ? 0.0001 : 0.16, this.t, 0.2);
    }
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(m ? 0.0001 : 0.9, this.t, 0.05);
    }
  }
}
