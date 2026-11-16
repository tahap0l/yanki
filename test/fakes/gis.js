// Sahte Google Identity Services
window.google = { accounts: { oauth2: {
  initTokenClient(o) {
    return { callback: o.callback, requestAccessToken(opts) { window.__gisPrompt = opts && opts.prompt; setTimeout(() => o.callback({ access_token: 'yt-token', expires_in: 3600 }), 60); } };
  },
  revoke(t, cb) { window.__revoked = t; cb && cb(); },
} } };
