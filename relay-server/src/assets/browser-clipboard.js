/*
 * Injected into ttyd's client (via ttyd -I) to give the browser view native
 * copy/paste against the OS clipboard of the machine running the browser:
 *
 *   - Mouse-select text  -> automatically copied to the clipboard on release.
 *   - Ctrl+V / Cmd+V / Shift+Insert -> paste the clipboard into the terminal.
 *
 * ttyd 1.7.7 exposes the live xterm instance as window.term. ttyd's own copy
 * path relies on document.execCommand("copy"), which does nothing with the
 * canvas renderer (xterm draws its own selection overlay, so there is no native
 * DOM selection to copy). We read the selection straight from term.getSelection()
 * and use the modern async Clipboard API, which works because the page is served
 * over http://localhost (a secure context).
 */
(function () {
  'use strict';

  function whenTermReady(cb) {
    if (window.term && typeof window.term.getSelection === 'function') {
      cb(window.term);
      return;
    }
    var tries = 0;
    var iv = setInterval(function () {
      if (window.term && typeof window.term.getSelection === 'function') {
        clearInterval(iv);
        cb(window.term);
      } else if (++tries > 100) {
        // ~10s: give up quietly; the stock client still works, just without us.
        clearInterval(iv);
      }
    }, 100);
  }

  function makeToast() {
    var el = document.createElement('div');
    el.textContent = 'Copied';
    el.style.cssText = [
      'position:fixed', 'bottom:16px', 'right:16px', 'z-index:99999',
      'padding:6px 12px', 'border-radius:6px',
      'font:13px -apple-system,system-ui,sans-serif',
      'background:rgba(40,42,54,0.95)', 'color:#f8f8f2',
      'box-shadow:0 2px 8px rgba(0,0,0,0.4)',
      'opacity:0', 'transition:opacity 0.15s', 'pointer-events:none',
    ].join(';');
    document.body.appendChild(el);
    var hideTimer = null;
    return function flash(text) {
      el.textContent = text;
      el.style.opacity = '1';
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(function () { el.style.opacity = '0'; }, 900);
    };
  }

  whenTermReady(function (term) {
    var flash = makeToast();

    // --- Copy on mouse-select release ---------------------------------------
    // mouseup fires while the user gesture is still active, so writeText is
    // permitted by the browser.
    function copySelection() {
      var text = term.getSelection();
      if (!text) return;
      var done = function () { flash('Copied'); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () {
          if (legacyCopy(text)) done();
        });
      } else if (legacyCopy(text)) {
        done();
      }
    }

    function legacyCopy(text) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;top:-9999px';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch (e) { return false; }
    }

    document.addEventListener('mouseup', function () {
      // Defer so xterm finishes updating its selection model first.
      setTimeout(copySelection, 0);
    }, true);

    // --- Paste --------------------------------------------------------------
    // Handle the native paste event rather than intercepting Ctrl/Cmd+V and
    // calling navigator.clipboard.readText(): a paste event exposes its
    // clipboardData with no permission prompt, whereas readText() requires the
    // clipboard-read permission and silently fails until the user grants it.
    // We run on the capture phase and stop propagation so xterm's own paste
    // handler doesn't also fire (which would paste the text twice).
    document.addEventListener('paste', function (e) {
      if (!e.clipboardData) return;
      var text = e.clipboardData.getData('text/plain');
      if (!text) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      term.paste(text);
    }, true);
  });
})();
