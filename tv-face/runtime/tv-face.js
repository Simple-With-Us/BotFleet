/**
 * <tv-face> v4 — SVG/CSS/JS runtime
 *
 * Animation craft studied from bloub (https://bloub.vercel.app, MIT,
 * jeremy-prt/bloub).  We take the craft, not the x.ai black-blob silhouette.
 *
 * Bloub techniques adopted here:
 *   1. pure sample(t) — pose is a pure function of absolute time + state table
 *   2. per-state morph duration (SHAPE_MORPH-style), easeOutQuint primary
 *   3. freeze mid-fade (departFige): chain mid-transition freezes composite
 *   4. rest life = gaze drift + blink schedule (loopNoise + deterministic blinks)
 *   5. blinkIn on state entry for selected holds
 *   6. separate look morph timing (LOOK_MORPH) for gaze catch-up
 *   7. hold pose(t) is sample-driven, not only CSS infinite keyframes
 *
 * TV-Face keeps shell + glass face identity.  Bookend contract still holds
 * for film packs; this runtime is the code twin.
 */
(() => {
  let _uid = 0;

  // --- math (bloub Io / Lo / Ro family) ------------------------------------
  const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOutQuint = (t) => 1 - Math.pow(1 - t, 5);
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const TAU = Math.PI * 2;
  const LOOK_MORPH = 0.24; // bloub LOOK_MORPH seconds
  const DEFAULT_MORPH = 0.45; // bloub SHAPE_MORPH seconds

  /** Seamless 1D noise — pure of t (bloub Lo). */
  function loopNoise(t, period, seed = 0) {
    const p = (t / period) * TAU;
    return (
      0.55 * Math.sin(p + seed) +
      0.3 * Math.sin(2 * p + seed * 1.7 + 1.1) +
      0.15 * Math.sin(3 * p + seed * 2.3 + 2.4)
    );
  }

  /** mulberry-ish rng (bloub Ro). */
  function createRng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Deterministic blink schedule over a long horizon (pure). */
  const BLINKS = (() => {
    const rng = createRng(0x5eed);
    const out = [];
    let t = 1.4;
    while (t < 3600) {
      out.push(t);
      t += 1.9 + rng() * 2.7;
      if (rng() < 0.12) out.push(t + 0.12); // double blink
    }
    return out;
  })();

  function lidAt(t, entryBlinkAt) {
    // 1 open, 0 closed — pure of t (+ optional entry blink)
    let lid = 1;
    if (entryBlinkAt != null) {
      const p = (t - entryBlinkAt) / 0.2;
      if (p >= 0 && p < 1) lid = Math.min(lid, Math.abs(p * 2 - 1));
    }
    for (let i = 0; i < BLINKS.length; i++) {
      const b = BLINKS[i];
      if (b > t + 0.2) break;
      const d = t - b;
      if (d >= 0 && d < 0.14) {
        const u = d / 0.14;
        lid = Math.min(lid, u < 0.45 ? 1 - u / 0.45 : (u - 0.45) / 0.55);
        break;
      }
    }
    return clamp(lid);
  }

  /**
   * Rest liveliness — pure of absolute time t (seconds).
   * Bloub insight: rest does not float hard; life is gaze + blink + tiny breath.
   */
  function liveliness(t, entryBlinkAt) {
    return {
      gazeX: 6 * loopNoise(t, 7.5, 0.3),
      gazeY: 4 * loopNoise(t, 9.2, 1.1),
      tilt: 1.4 * loopNoise(t, 11, 2.0),
      breath: 1.5 * loopNoise(t, 4.8, 0.7),
      lid: lidAt(t, entryBlinkAt),
      wander: 0.35 + 0.15 * loopNoise(t, 13, 0.5),
    };
  }

  /**
   * State table (bloub-style: duration, morph, blinkIn, hold fields).
   * Hold motion is sampled as pose(localT), not CSS keyframes alone.
   */
  const STATES = {
    resting:   { morph: 0.45, blinkIn: false, tilt: 0, bob: 0, scale: 1, eyeOpen: 1, mouth: 0 },
    thinking:  { morph: 0.40, blinkIn: true,  tilt: -4, bob: -6, scale: 1.02, eyeOpen: 1, mouth: 0 },
    working:   { morph: 0.35, blinkIn: false, tilt: 2, bob: 2, scale: 1, eyeOpen: 1, mouth: 0 },
    waiting:   { morph: 0.45, blinkIn: true,  tilt: 5, bob: 0, scale: 1, eyeOpen: 0.95, mouth: 0 },
    celebrate: { morph: 0.35, blinkIn: true,  tilt: 0, bob: -12, scale: 1.05, eyeOpen: 1.05, mouth: 0.35 },
    error:     { morph: 0.30, blinkIn: false, tilt: -3, bob: 0, scale: 1, eyeOpen: 1.1, mouth: 0 },
    sleeping:  { morph: 0.50, blinkIn: false, tilt: -2, bob: 3, scale: 0.98, eyeOpen: 0.08, mouth: 0 },
  };

  function holdPose(state, localT) {
    const base = STATES[state] || STATES.resting;
    let tilt = base.tilt;
    let bob = base.bob;
    let scale = base.scale;
    let eyeOpen = base.eyeOpen;
    let mouth = base.mouth;
    // sample-driven hold motion (localT = seconds in hold)
    if (state === 'thinking') {
      tilt = base.tilt + 4 * Math.sin(localT * 2.2);
      bob = base.bob + 5 * Math.sin(localT * 2.0);
    } else if (state === 'working') {
      tilt = base.tilt + 2.5 * Math.sin(localT * 4.0);
      bob = base.bob + 2 * Math.sin(localT * 4.0);
    } else if (state === 'waiting') {
      tilt = base.tilt * Math.sin(localT * 1.1);
    } else if (state === 'celebrate') {
      bob = base.bob * (0.5 + 0.5 * Math.sin(localT * 8));
      scale = 1 + 0.04 * Math.sin(localT * 8);
      mouth = base.mouth * (0.7 + 0.3 * Math.abs(Math.sin(localT * 6)));
    } else if (state === 'error') {
      tilt = 3 * Math.sin(localT * 18);
      bob = 0;
    } else if (state === 'sleeping') {
      bob = base.bob + 2 * Math.sin(localT * 1.2);
      scale = 0.98 + 0.01 * Math.sin(localT * 1.2);
    }
    return { tilt, bob, scale, eyeOpen, mouth };
  }

  function lerpPose(a, b, e) {
    return {
      tilt: lerp(a.tilt, b.tilt, e),
      bob: lerp(a.bob, b.bob, e),
      scale: lerp(a.scale, b.scale, e),
      eyeOpen: lerp(a.eyeOpen, b.eyeOpen, e),
      mouth: lerp(a.mouth, b.mouth, e),
    };
  }

  const FALLBACK_CSS = `
:host{display:inline-block;width:var(--tv-size,240px);height:var(--tv-size,240px);
--shell-shadow:#782d0f;--shell-base:#d25f23;--shell-highlight:#ffbe78;--glyph:#22d3ee;--glass:#05070a;
--float-opacity:.28;--bob-amp:0px;--tilt-deg:0deg;--scale:1;--mouth-open:0;--spec-x:36%;--spec-y:28%;
--gaze-x:0px;--gaze-y:0px;--lid:1;--eye-open:1;
background:transparent;line-height:0;position:relative;vertical-align:middle}
:host([float]){--float-opacity:.42}
:host([casing="blue"]){--shell-shadow:#0f2d6e;--shell-base:#286ec8;--shell-highlight:#8cc8ff}
:host([casing="purple"]){--shell-shadow:#371464;--shell-base:#8237be;--shell-highlight:#d2a0ff}
:host([casing="pink"]){--shell-shadow:#781946;--shell-base:#dc468c;--shell-highlight:#ffb4d2}
:host([casing="white"]){--shell-shadow:#8c919b;--shell-base:#dcdee4;--shell-highlight:#fff}
:host([casing="black"]){--shell-shadow:#0c0e12;--shell-base:#2d3037;--shell-highlight:#a0a5af}
:host([casing="green"]){--shell-shadow:#0f4a28;--shell-base:#1f9a4a;--shell-highlight:#8dffb0;--glyph:#ef4444}
:host([casing="cyan"]){--shell-shadow:#0a4a55;--shell-base:#14b8c8;--shell-highlight:#a5f3fc}
:host([casing="red"]){--shell-shadow:#6b1010;--shell-base:#dc2626;--shell-highlight:#fca5a5}
:host([casing="yellow"]){--shell-shadow:#6b5508;--shell-base:#eab308;--shell-highlight:#fef08a}
:host([casing="teal"]){--shell-shadow:#0f3f3a;--shell-base:#14b8a6;--shell-highlight:#99f6e4}
:host([casing="coral"]){--shell-shadow:#7a2e1a;--shell-base:#f97316;--shell-highlight:#fdba74}
.wrap,.tv{width:100%;height:100%;background:transparent;display:block;overflow:visible}
.hybrid{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;
  opacity:0;transition:opacity .25s ease;border-radius:12%}
:host([hybrid-active]) .hybrid{opacity:1}
:host([hybrid-active]) .rig-glyphs{opacity:0}
.rig{transform-origin:480px 520px;transform:translateY(var(--bob-amp)) rotate(var(--tilt-deg)) scale(var(--scale));
  transition: none}
@media (prefers-reduced-motion:reduce){:host{--bob-amp:0px !important;--tilt-deg:0deg !important}}
.shell-fill{fill:url(#__SHELL__)}.ear-fill{fill:url(#__EAR__)}.glass{fill:var(--glass)}
.glyph{fill:none;stroke:var(--glyph);stroke-linecap:round;filter:url(#__NEON__)}
.glyph-fill{fill:var(--glyph);filter:url(#__NEON__)}
.state-glyph{opacity:0;stroke:var(--glyph);fill:none;stroke-width:10;stroke-linecap:round;filter:url(#__NEON__);transition:opacity .18s}
:host([state="thinking"]) .g-think,:host([state="working"]) .g-work,:host([state="waiting"]) .g-wait,
:host([state="celebrate"]) .g-celeb,:host([state="error"]) .g-error,:host([state="sleeping"]) .g-sleep{opacity:1}
.mouth-open-path{opacity:0}
:host([speaking]) .mouth-closed{opacity:calc(1 - var(--mouth-open))}
:host([speaking]) .mouth-open-path{opacity:var(--mouth-open)}
.eye-group{transform:translate(var(--gaze-x), var(--gaze-y))}
.blink-lid{transform-origin:480px 435px;transform:scaleY(calc(1 - var(--lid)))}
.pupil{transform-box:fill-box;transform-origin:center}
`;

  class TvFace extends HTMLElement {
    static get observedAttributes() {
      return ['state', 'casing', 'phase', 'speaking', 'float', 'size', 'hybrid-src'];
    }
    constructor() {
      super();
      this._id = `tv${++_uid}`;
      this.attachShadow({ mode: 'open' });
      this._t0 = performance.now() / 1000;
      this._raf = 0;
      // bloub-style machine
      this._cur = 'resting';
      this._prev = null;
      this._tCur = 0;
      this._tPrev = 0;
      this._departFige = null; // frozen composite pose when chaining mid-fade
      this._blinkAt = -10;
      this._look = { x: 0, y: 0 };
      this._lookPrev = { x: 0, y: 0 };
      this._lookAt = -10;
      this._speakOpen = 0;
      this._speakTimer = null;
      this._hybrid = null;
      this._holdLocal0 = 0;
    }
    connectedCallback() {
      this.shadowRoot.innerHTML = this._template();
      this._hybrid = this.shadowRoot.querySelector('.hybrid');
      if (!this.hasAttribute('state')) this.setAttribute('state', 'resting');
      if (!this.hasAttribute('phase')) this.setAttribute('phase', 'rest');
      if (!this.hasAttribute('casing')) this.setAttribute('casing', 'orange');
      this._cur = this.getAttribute('state') || 'resting';
      this._applySize();
      this._startLoop();
    }
    disconnectedCallback() {
      cancelAnimationFrame(this._raf);
      clearInterval(this._speakTimer);
    }
    attributeChangedCallback(name, o, v) {
      if (o === v) return;
      if (name === 'size') this._applySize();
      if (name === 'phase') this._emit('tv-phase', { phase: v });
      if (name === 'hybrid-src') this._syncHybrid();
      if (name === 'state' || name === 'phase') this._syncHybridPhase(this.getAttribute('phase'));
      if (name === 'state' && v && v !== this._cur) {
        // external attr set → route through setState machine
        const t = performance.now() / 1000 - this._t0;
        this._setStateInternal(v, t);
      }
    }
    _applySize() {
      const s = this.getAttribute('size') || '240px';
      this.style.setProperty('--tv-size', s);
    }
    _sid(n) { return `${this._id}-${n}`; }
    _template() {
      const shell = this._sid('shell');
      const ear = this._sid('ear');
      const neon = this._sid('neon');
      const css = FALLBACK_CSS
        .replaceAll('__SHELL__', shell)
        .replaceAll('__EAR__', ear)
        .replaceAll('__NEON__', neon);
      return `
<style>${css}</style>
<img class="hybrid" alt=""/>
<svg class="tv wrap" viewBox="0 0 960 960" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="${shell}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="var(--shell-highlight)"/>
      <stop offset="45%" stop-color="var(--shell-base)"/>
      <stop offset="100%" stop-color="var(--shell-shadow)"/>
    </linearGradient>
    <linearGradient id="${ear}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--shell-highlight)"/>
      <stop offset="100%" stop-color="var(--shell-shadow)"/>
    </linearGradient>
    <filter id="${neon}" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="3" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <radialGradient id="${this._sid('spec')}" cx="var(--spec-x)" cy="var(--spec-y)" r="55%">
      <stop offset="0%" stop-color="#fff" stop-opacity="0.22"/>
      <stop offset="55%" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <g class="rig">
    <ellipse class="ear-fill" cx="175" cy="470" rx="42" ry="70"/>
    <ellipse class="ear-fill" cx="785" cy="470" rx="42" ry="70"/>
    <rect class="shell-fill" x="210" y="210" width="540" height="500" rx="72"/>
    <rect class="glass" x="255" y="270" width="450" height="340" rx="36"/>
    <rect fill="url(#${this._sid('spec')})" x="255" y="270" width="450" height="340" rx="36"/>
    <g class="rig-glyphs eye-group">
      <g class="eye-left">
        <ellipse class="glyph-fill" cx="390" cy="420" rx="28" ry="32" opacity="0.95"/>
        <ellipse class="pupil" cx="390" cy="420" rx="10" ry="12" fill="#0a0a0c"/>
      </g>
      <g class="eye-right">
        <ellipse class="glyph-fill" cx="570" cy="420" rx="28" ry="32" opacity="0.95"/>
        <ellipse class="pupil" cx="570" cy="420" rx="10" ry="12" fill="#0a0a0c"/>
      </g>
      <rect class="blink-lid glass" x="340" y="380" width="280" height="80" rx="12" opacity="0.92"/>
      <path class="glyph mouth-closed" d="M380 580 Q480 640 580 580" stroke-width="14"/>
      <ellipse class="glyph-fill mouth-open-path" cx="480" cy="600" rx="70" ry="36"/>
      <g class="state-glyph g-think"><circle cx="640" cy="300" r="10" class="glyph-fill"/><circle cx="670" cy="270" r="7" class="glyph-fill"/><circle cx="690" cy="245" r="5" class="glyph-fill"/></g>
      <g class="state-glyph g-work"><path d="M340 300 h80 M340 320 h60" stroke-width="10"/></g>
      <g class="state-glyph g-wait"><path d="M480 300 v50 M480 360 v8" stroke-width="12"/></g>
      <g class="state-glyph g-celeb"><path d="M320 280 l20 30 l-30 10 l30 10 l-20 30 l20-30 l30 10 l-30-10 z" stroke-width="6"/></g>
      <g class="state-glyph g-error"><path d="M450 300 h60 M480 300 v55" stroke-width="14"/><circle cx="480" cy="380" r="6" class="glyph-fill"/></g>
      <g class="state-glyph g-sleep"><path d="M600 300 q20 -20 40 0" stroke-width="8"/><path d="M620 280 q16 -16 32 0" stroke-width="6"/></g>
    </g>
  </g>
  <ellipse cx="480" cy="780" rx="160" ry="18" fill="#000" opacity="var(--float-opacity)"/>
</svg>`;
    }

    /**
     * bloub setState: if still morphing, freeze composite (departFige).
     */
    _setStateInternal(next, t) {
      if (next === this._cur) return;
      const meta = STATES[this._cur] || STATES.resting;
      const morphing = this._prev !== null && (t - this._tCur) < meta.morph;
      this._departFige = morphing ? this._poseComposee(t) : null;
      this._prev = this._cur;
      this._tPrev = this._tCur;
      this._cur = next;
      this._tCur = t;
      this._holdLocal0 = t;
      const nextMeta = STATES[next] || STATES.resting;
      if (nextMeta.blinkIn) this._blinkAt = t;
    }

    /** Composite pose at t (for freeze origin). */
    _poseComposee(t) {
      return this._corePose(t);
    }

    /** Core body pose without liveliness. */
    _corePose(t) {
      const phase = this.getAttribute('phase') || 'rest';
      const meta = STATES[this._cur] || STATES.resting;
      const local = Math.max(0, t - this._tCur);
      let target;
      if (phase === 'hold' || phase === 'enter') {
        target = holdPose(this._cur, Math.max(0, t - this._holdLocal0));
      } else if (this._cur === 'resting' || phase === 'rest' || phase === 'return') {
        target = holdPose('resting', local);
      } else {
        target = holdPose(this._cur, local);
      }

      // morph from origin
      const morphDur = meta.morph || DEFAULT_MORPH;
      if (local < morphDur) {
        const e = easeOutQuint(clamp(local / morphDur));
        const origin = this._departFige || (this._prev
          ? holdPose(this._prev, Math.max(0, t - this._tPrev))
          : holdPose('resting', 0));
        return lerpPose(origin, target, e);
      }
      // clear freeze after complete morph
      if (this._departFige) this._departFige = null;
      return target;
    }

    /**
     * sample(t) — pure of absolute time + machine state.
     * Same t + same machine => same fields.
     */
    sample(t) {
      const phase = this.getAttribute('phase') || 'rest';
      const pose = this._corePose(t);

      const liveOn = (phase === 'rest' || phase === 'hold' || phase === 'enter' || phase === 'return');
      const live = liveOn
        ? liveliness(t, this._blinkAt)
        : { gazeX: 0, gazeY: 0, tilt: 0, breath: 0, lid: 1, wander: 0 };

      // LOOK_MORPH: ease gaze toward liveliness target
      const lookT = clamp((t - this._lookAt) / LOOK_MORPH);
      const lookE = easeOutCubic(lookT);
      // retarget look occasionally via liveliness itself (already continuous)

      let lid = live.lid;
      let eyeOpen = pose.eyeOpen;
      if (this._cur === 'sleeping') {
        lid = Math.min(lid, 0.12);
        eyeOpen = 0.08;
      }

      let mouth = pose.mouth;
      if (this.hasAttribute('speaking')) mouth = Math.max(mouth, this._speakOpen);

      const restMix = phase === 'rest' ? 1 : 0.35;
      return {
        tilt: pose.tilt + live.tilt * restMix,
        bob: pose.bob + live.breath * (phase === 'rest' ? 1 : 0.25),
        scale: pose.scale,
        eyeOpen,
        mouth,
        gazeX: live.gazeX,
        gazeY: live.gazeY,
        lid,
        specX: 36 + pose.tilt * 1.2,
        specY: 28 - Math.abs(pose.tilt) * 0.2,
      };
    }

    _applyPose(pose) {
      this.style.setProperty('--tilt-deg', `${pose.tilt.toFixed(2)}deg`);
      this.style.setProperty('--bob-amp', `${pose.bob.toFixed(1)}px`);
      this.style.setProperty('--scale', pose.scale.toFixed(4));
      this.style.setProperty('--mouth-open', clamp(pose.mouth).toFixed(3));
      this.style.setProperty('--gaze-x', `${pose.gazeX.toFixed(1)}px`);
      this.style.setProperty('--gaze-y', `${pose.gazeY.toFixed(1)}px`);
      this.style.setProperty('--lid', pose.lid.toFixed(3));
      this.style.setProperty('--eye-open', pose.eyeOpen.toFixed(3));
      this.style.setProperty('--spec-x', `${pose.specX.toFixed(1)}%`);
      this.style.setProperty('--spec-y', `${pose.specY.toFixed(1)}%`);
      const ry = Math.max(2, 32 * pose.eyeOpen * pose.lid);
      if (!this._eyeEls) {
        this._eyeEls = [...this.shadowRoot.querySelectorAll('.eye-left ellipse.glyph-fill, .eye-right ellipse.glyph-fill')];
      }
      for (const el of this._eyeEls) el.setAttribute('ry', ry.toFixed(1));
    }

    _startLoop() {
      const tick = () => {
        const t = performance.now() / 1000 - this._t0;
        this._applyPose(this.sample(t));
        this._raf = requestAnimationFrame(tick);
      };
      this._raf = requestAnimationFrame(tick);
    }

    _currentPose() {
      const t = performance.now() / 1000 - this._t0;
      return this.sample(t);
    }

    async play(state, { holdMs = Infinity, autoReturn = false } = {}) {
      const s = state || 'thinking';
      if (s === 'resting') return this.stop();
      const t = performance.now() / 1000 - this._t0;
      this._setStateInternal(s, t);
      this.setAttribute('state', s);
      this.setAttribute('phase', 'enter');
      const morphMs = ((STATES[s] || STATES.resting).morph || DEFAULT_MORPH) * 1000;
      await wait(morphMs);
      this.setAttribute('phase', 'hold');
      this._holdLocal0 = performance.now() / 1000 - this._t0;
      if (Number.isFinite(holdMs)) {
        await wait(holdMs);
        if (autoReturn) await this.stop();
      }
    }
    async stop() {
      const t = performance.now() / 1000 - this._t0;
      this.setAttribute('phase', 'return');
      this._setStateInternal('resting', t);
      this.setAttribute('state', 'resting');
      await wait((STATES.resting.morph || DEFAULT_MORPH) * 1000);
      this.setAttribute('phase', 'rest');
    }
    setSpeaking(on, open01 = 0) {
      if (on) this.setAttribute('speaking', '');
      else this.removeAttribute('speaking');
      this._speakOpen = clamp(open01);
    }
    startTalking(hz = 4) {
      this.setSpeaking(true, 0);
      clearInterval(this._speakTimer);
      let n = 0;
      this._speakTimer = setInterval(() => {
        n += 1;
        this._speakOpen = 0.12 + 0.88 * Math.abs(Math.sin(n * hz * 0.32));
      }, 48);
    }
    stopTalking() {
      clearInterval(this._speakTimer);
      this._speakOpen = 0;
      this.setSpeaking(false, 0);
    }
    setCasing(name) { this.setAttribute('casing', name); }
    setHybrid(src) {
      if (src) this.setAttribute('hybrid-src', src);
      else this.removeAttribute('hybrid-src');
    }
    _syncHybrid() {
      const src = this.getAttribute('hybrid-src');
      if (!this._hybrid) return;
      if (src) { this._hybrid.src = src; }
      else { this._hybrid.removeAttribute('src'); this.removeAttribute('hybrid-active'); }
    }
    _syncHybridPhase(phase) {
      if (this.getAttribute('hybrid-src') && phase === 'hold') this.setAttribute('hybrid-active', '');
      else this.removeAttribute('hybrid-active');
    }
    _emit(name, detail) {
      this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
    }
  }

  function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
  if (!customElements.get('tv-face')) customElements.define('tv-face', TvFace);
  window.TvFace = TvFace;
})();
