/**
 * BotFleet TV-Face Player — multi-bot / multi-seat framework
 * One player class, many skins. Each BotFleet seat owns a TVFace
 * instance pointing at skins/<skinId>/ with identical clip names.
 *
 *   const face = new TVFace({ el: imgElement, skinBase: '/assets/TV-Face/skins/default' });
 *   face.show('thinking');
 *   face.toIdle();
 */

export class TVFace {
  constructor({ el, skinBase, manifest = null, enterMs = 2500, returnMs = 2500 }) {
    this.root = el;
    this.img = el.tagName === 'IMG' ? el : (el.querySelector('img') || this._makeImg(el));
    this.skinBase = skinBase.replace(/\/$/, '');
    this.manifest = manifest;
    this.enterMs = enterMs;
    this.returnMs = returnMs;
    this.current = 'resting';
    this.state = 'idle';
    this._timer = null;
    this._token = 0;
    this.toRestingStill();
  }

  _makeImg(parent) {
    const img = document.createElement('img');
    img.alt = 'BotFleet TV-Face';
    img.decoding = 'async';
    img.style.width = '100%';
    img.style.height = '100%';
    img.style.objectFit = 'contain';
    parent.appendChild(img);
    return img;
  }

  path(rel) { return `${this.skinBase}/${rel}`; }

  toRestingStill() {
    this.img.src = this.path('stills/resting.png');
    this.current = 'resting';
    this.state = 'idle';
  }

  async show(name) {
    if (!name || name === 'resting') return this.toIdle();
    if (this.current === name && this.state === 'holding') return;
    const token = ++this._token;
    clearTimeout(this._timer);

    if (this.current !== 'resting' && this.current !== name && this.state === 'holding') {
      this.state = 'returning';
      this.img.src = this.path(`gifs/${this.current}_return.gif`);
      await this._wait(this.returnMs, token);
      if (token !== this._token) return;
    }

    this.state = 'entering';
    this.current = name;
    this.img.src = this.path(`gifs/${name}_enter.gif`);
    await this._wait(this.enterMs, token);
    if (token !== this._token) return;

    this.state = 'holding';
    this.img.src = this.path(`gifs/${name}_hold.gif`);
  }

  async toIdle() {
    if (this.current === 'resting' && this.state === 'idle') return;
    const token = ++this._token;
    clearTimeout(this._timer);
    const from = this.current;
    if (from && from !== 'resting') {
      this.state = 'returning';
      this.img.src = this.path(`gifs/${from}_return.gif`);
      await this._wait(this.returnMs, token);
      if (token !== this._token) return;
    }
    this.toRestingStill();
  }

  onEvent(eventName) {
    const map = (this.manifest && this.manifest.eventMap) || {};
    const expr = map[eventName];
    if (!expr || expr === 'resting') return this.toIdle();
    return this.show(expr);
  }

  bindEvents(bus, prefix = '') {
    const map = (this.manifest && this.manifest.eventMap) || {};
    for (const key of Object.keys(map)) {
      const handler = () => this.onEvent(key);
      if (typeof bus.on === 'function') bus.on(prefix + key, handler);
      else if (typeof bus.addEventListener === 'function') bus.addEventListener(prefix + key, handler);
    }
  }

  setSkin(skinBase) {
    this.skinBase = skinBase.replace(/\/$/, '');
    if (this.state === 'holding' && this.current !== 'resting') {
      this.img.src = this.path(`gifs/${this.current}_hold.gif`);
    } else if (this.state === 'idle') {
      this.toRestingStill();
    }
  }

  _wait(ms, token) {
    return new Promise((resolve) => {
      this._timer = setTimeout(() => resolve(), ms);
    });
  }
}

/** Multi-seat registry — one face per BotFleet seat / agent. */
export class TVFaceBoard {
  constructor({ skinRoot, defaultSkin = 'default', manifest = null }) {
    this.skinRoot = skinRoot.replace(/\/$/, '');
    this.defaultSkin = defaultSkin;
    this.manifest = manifest;
    this.seats = new Map();
  }

  mount(seatId, el, skinId) {
    const skin = skinId || this.defaultSkin;
    const face = new TVFace({
      el,
      skinBase: `${this.skinRoot}/${skin}`,
      manifest: this.manifest,
    });
    this.seats.set(seatId, face);
    return face;
  }

  get(seatId) { return this.seats.get(seatId); }
  show(seatId, expression) { return this.get(seatId)?.show(expression); }
  toIdle(seatId) { return this.get(seatId)?.toIdle(); }
  onEvent(seatId, eventName) { return this.get(seatId)?.onEvent(eventName); }
  setSkin(seatId, skinId) {
    const face = this.get(seatId);
    if (face) face.setSkin(`${this.skinRoot}/${skinId}`);
  }
  broadcast(expression) { for (const f of this.seats.values()) f.show(expression); }
  allIdle() { for (const f of this.seats.values()) f.toIdle(); }
}

export default TVFace;
