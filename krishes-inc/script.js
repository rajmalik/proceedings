/* Krishes Inc. · minimal, black & white.
 * 1) IntersectionObserver reveals (fade + ~10px rise), per-section stagger via --i.
 * 2) Nav gains a stronger hairline on scroll.
 * 3) Copy-email affordance with success/error state.
 * All animation is bypassed under prefers-reduced-motion. */
(function () {
  'use strict';

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ─── Nav scroll-frost ─── */
  var nav = document.getElementById('nav');
  if (nav) {
    var ticking = false;
    function onScroll() { nav.classList.toggle('is-scrolled', window.scrollY > 16); ticking = false; }
    window.addEventListener('scroll', function () {
      if (!ticking) { requestAnimationFrame(onScroll); ticking = true; }
    }, { passive: true });
    onScroll();
  }

  /* ─── Copy the email address ─── */
  var copyBtn = document.getElementById('copy-email');
  if (copyBtn) {
    var stateEl = copyBtn.querySelector('.copybtn__state');
    var email = copyBtn.getAttribute('data-email') || '';
    var resetTimer;
    copyBtn.addEventListener('click', function () {
      function done(ok) {
        clearTimeout(resetTimer);
        copyBtn.classList.remove('is-copied', 'is-error');
        copyBtn.classList.add(ok ? 'is-copied' : 'is-error');
        if (stateEl) stateEl.textContent = ok ? 'Copied' : 'Press \u2318C';
        resetTimer = setTimeout(function () {
          copyBtn.classList.remove('is-copied', 'is-error');
          if (stateEl) stateEl.textContent = 'Copy';
        }, 1800);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(email).then(function () { done(true); }).catch(function () { done(false); });
      } else {
        done(false);
      }
    });
  }

  /* ─── Reveals ─── */
  if (reduced || !('IntersectionObserver' in window)) {
    document.querySelectorAll('.reveal').forEach(function (el) { el.classList.add('is-inview'); });
    return;
  }
  var revealHosts = document.querySelectorAll('main > section, #work > section, .foot-stmt');
  var io = new IntersectionObserver(function (entries, obs) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      entry.target.querySelectorAll('.reveal').forEach(function (el) { el.classList.add('is-inview'); });
      obs.unobserve(entry.target);
    });
  }, { rootMargin: '0px 0px -10% 0px', threshold: 0.08 });
  revealHosts.forEach(function (s) { if (s.querySelector('.reveal')) io.observe(s); });
})();
