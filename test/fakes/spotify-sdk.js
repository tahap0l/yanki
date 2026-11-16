// Sahte Spotify Web Playback SDK (test için)
(function () {
  const listeners = {};
  let state = null;
  const mode = window.__fakeSdkMode || 'ok';
  const emit = (ev, x) => (listeners[ev] || []).forEach((cb) => cb(x));
  const catalog = window.__fakeCatalogInit || {};
  class Player {
    constructor(o) { this.o = o; window.__fakePlayer = this; }
    addListener(ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); return true; }
    connect() {
      return new Promise((res) => this.o.getOAuthToken((t) => {
        window.__sdkToken = t;
        setTimeout(() => { if (mode === 'account_error') emit('account_error', { message: 'premium' }); else emit('ready', { device_id: 'dev-browser' }); }, 50);
        res(true);
      }));
    }
    disconnect() {}
    activateElement() { window.__activated = (window.__activated || 0) + 1; return Promise.resolve(); }
    togglePlay() { if (state) { state.paused = !state.paused; emit('player_state_changed', state); } window.__toggles = (window.__toggles || 0) + 1; return Promise.resolve(); }
    nextTrack() { return this._move(1); }
    previousTrack() { return this._move(-1); }
    seek(ms) { if (state) { state.position = ms; emit('player_state_changed', state); } return Promise.resolve(); }
    _move(d) { if (!state) return Promise.resolve(); const q = state.__queue; state.__i = Math.max(0, Math.min(q.length - 1, state.__i + d)); this._set(q, state.__i); return Promise.resolve(); }
    _set(q, i) {
      const t = catalog[q[i]] || { id: q[i].split(':').pop(), uri: q[i], name: 'Bilinmeyen', artists: [{ name: '?' }], album: { name: '', images: [] }, duration_ms: 200000 };
      state = { paused: false, position: 0, duration: t.duration_ms, track_window: { current_track: t }, disallows: {}, __queue: q, __i: i };
      emit('player_state_changed', state);
    }
  }
  window.__fakeSpotify = {
    play(body) {
      let q = body.uris || window.__fakeContexts[body.context_uri] || [];
      let i = 0;
      if (body.offset && body.offset.uri) i = Math.max(0, q.indexOf(body.offset.uri));
      window.__fakePlayer._set(q, i);
    },
  };
  window.Spotify = { Player };
  setTimeout(() => window.onSpotifyWebPlaybackSDKReady && window.onSpotifyWebPlaybackSDKReady(), 30);
})();
