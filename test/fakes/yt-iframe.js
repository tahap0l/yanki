// Sahte YouTube IFrame API (görünür bir kutu çizer)
(function () {
  const PS = { PLAYING: 1, PAUSED: 2, ENDED: 0, BUFFERING: 3, CUED: 5 };
  class Player {
    constructor(el, o) {
      this.o = o; this.list = o.playerVars && o.playerVars.playlist ? [o.videoId].concat(o.playerVars.playlist.split(',')) : [o.videoId];
      this.i = 0; this.st = -1; this.t = 0;
      this.box = document.createElement('div');
      this.box.className = 'fake-yt';
      this.box.style.cssText = 'position:absolute;inset:0;display:grid;place-items:center;background:#111;color:#fff;font:14px sans-serif';
      el.replaceWith(this.box);
      window.__ytPlayer = this;
      setTimeout(() => { o.events.onReady && o.events.onReady({ target: this }); this._play(); }, 40);
    }
    _render() { this.box.textContent = 'YouTube oynatıcısı (test) · ' + this.list[this.i]; }
    _play() { this.st = PS.PLAYING; this._render(); this.o.events.onStateChange && this.o.events.onStateChange({ data: this.st }); }
    getPlayerState() { return this.st; }
    playVideo() { this._play(); }
    pauseVideo() { this.st = PS.PAUSED; this.o.events.onStateChange({ data: this.st }); }
    nextVideo() { this.i = Math.min(this.list.length - 1, this.i + 1); this.t = 0; this._play(); }
    previousVideo() { this.i = Math.max(0, this.i - 1); this.t = 0; this._play(); }
    seekTo(s) { this.t = s; }
    getCurrentTime() { return this.t + (this.st === PS.PLAYING ? 1 : 0); }
    getDuration() { return 240; }
    getPlaylistIndex() { return this.i; }
    getVideoData() { return { video_id: this.list[this.i], title: 'Video ' + this.list[this.i], author: 'Kanal - Topic' }; }
    loadPlaylist(list, index) { if (Array.isArray(list)) { this.list = list; this.i = index || 0; } else { this.list = window.__ytLists[list.list] || ['x']; this.i = list.index || 0; } this._play(); }
    loadVideoById(id) { this.list = [id]; this.i = 0; this._play(); }
    destroy() { this.box.remove(); }
  }
  window.YT = { Player, PlayerState: PS };
  setTimeout(() => window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady(), 20);
})();
