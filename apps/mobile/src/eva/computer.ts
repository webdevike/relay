/**
 * Eva's computer: the contained Chromium Eva drives, as a Selkies web screen Isaac can watch and
 * type into from the phone. The web view opens `EVA_COMPUTER_URL`; the scripts below run inside the
 * stream page.
 */

/**
 * The Selkies screen on the Mac Mini, published on the tailnet by `tailscale serve` (MagicDNS name
 * required, no auth: being on the tailnet is the auth). See `workflows/eva-browser.md`.
 */
export const EVA_COMPUTER_URL = "https://isaacs-mac-mini.tail80fdb0.ts.net:3100/";

/** Messages the injected scripts post back through `window.ReactNativeWebView`. */
export const KEYBOARD_FOCUSED = "keyboard:focused";
export const KEYBOARD_NONE = "keyboard:none";

/**
 * Makes the page pinch-zoomable. Selkies can set `user-scalable=no`, which locks the native pinch;
 * this rewrites the viewport meta to allow scaling up to 5x (keeping its other terms, adding the
 * meta when the page has none) and re-applies it if the page changes it later.
 */
export const ALLOW_PINCH_ZOOM_JS = `
(function () {
  var DROP = /^(user-scalable|maximum-scale|minimum-scale)\\s*=/i;
  function apply() {
    var head = document.head || document.documentElement;
    var meta = document.querySelector('meta[name="viewport"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'viewport');
      head.appendChild(meta);
    }
    var terms = (meta.getAttribute('content') || '')
      .split(',')
      .map(function (term) { return term.trim(); })
      .filter(function (term) { return term !== '' && !DROP.test(term); });
    if (!terms.some(function (term) { return /^width\\s*=/i.test(term); })) terms.unshift('width=device-width');
    terms.push('user-scalable=yes', 'maximum-scale=5');
    var next = terms.join(', ');
    if (meta.getAttribute('content') !== next) meta.setAttribute('content', next);
  }
  apply();
  if (window.MutationObserver && !window.__evaPinchZoom) {
    window.__evaPinchZoom = new MutationObserver(apply);
    window.__evaPinchZoom.observe(document.head || document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['content'],
    });
  }
})();
true;
`;

/**
 * Focuses Selkies' hidden keyboard field so iOS raises the keyboard: the first element whose id
 * contains "keyboard" or "input" that accepts focus, else the first `input` or `textarea`. Posts
 * KEYBOARD_FOCUSED, or KEYBOARD_NONE when nothing took focus (Selkies adds the field after the first tap).
 */
export const FOCUS_KEYBOARD_JS = `
(function () {
  var selectors = ['[id*="keyboard" i]', '[id*="input" i]', 'input', 'textarea'];
  var focused = false;
  for (var s = 0; s < selectors.length && !focused; s++) {
    var found = document.querySelectorAll(selectors[s]);
    for (var i = 0; i < found.length && !focused; i++) {
      var el = found[i];
      if (typeof el.focus !== 'function') continue;
      el.focus();
      focused = document.activeElement === el;
    }
  }
  window.ReactNativeWebView.postMessage(focused ? '${KEYBOARD_FOCUSED}' : '${KEYBOARD_NONE}');
})();
true;
`;

/** Drops focus from the stream page's field so iOS lowers the keyboard. */
export const BLUR_KEYBOARD_JS = `
(function () {
  if (document.activeElement && typeof document.activeElement.blur === 'function') document.activeElement.blur();
})();
true;
`;
