'use strict';
// Game sounds, synthesised with the Web Audio API (no audio files to load).
// Browsers only allow audio after the player touches the page, so the audio context is unlocked on the first tap/click.
const Sound = (() => {
  let ctx = null, master = null;
  // Volume 0..1, remembered per device. Devices muted with the older on/off button start at 0.
  let volume = 0.7;
  try {
    const saved = localStorage.getItem('bc-volume');
    if (saved !== null && !isNaN(+saved)) volume = Math.min(1, Math.max(0, +saved));
    else if (localStorage.getItem('bc-muted') === '1') volume = 0;
  } catch {}

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = volume;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }
  for (const ev of ['pointerdown', 'keydown', 'touchend']) addEventListener(ev, ensure, { passive: true });

  // One note: frequency in Hz, start offset and duration in seconds, with a quick fade in/out so it never clicks.
  function tone(freq, start, dur, { type = 'sine', vol = 0.2, slideTo } = {}) {
    const t0 = ctx.currentTime + start;
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  const SOUNDS = {
    start() { [523, 659, 784].forEach((f, i) => tone(f, i * 0.1, i === 2 ? 0.25 : 0.12, { type: 'triangle', vol: 0.18 })); },
    tick() { tone(1000, 0, 0.05, { type: 'square', vol: 0.06 }); },
    tickHigh() { tone(1400, 0, 0.07, { type: 'square', vol: 0.09 }); },
    lock() { tone(620, 0, 0.09, { vol: 0.22, slideTo: 980 }); },
    correct() { [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.08, i === 3 ? 0.35 : 0.16, { type: 'triangle', vol: 0.18 })); },
    wrong() {
      tone(240, 0, 0.22, { type: 'sawtooth', vol: 0.07, slideTo: 170 });
      tone(170, 0.2, 0.4, { type: 'sawtooth', vol: 0.07, slideTo: 110 });
    },
    join() { tone(880, 0, 0.12, { vol: 0.12, slideTo: 1320 }); },
    fanfare() {
      const seq = [[523, 0], [523, 0.12], [523, 0.24], [659, 0.36], [784, 0.6], [659, 0.78], [784, 0.9], [1047, 1.05]];
      seq.forEach(([f, s], i) => tone(f, s, i === seq.length - 1 ? 0.7 : 0.14, { type: 'triangle', vol: 0.16 }));
    },
  };

  return {
    play(name) {
      if (volume === 0 || !SOUNDS[name]) return;
      if (!ensure()) return;
      try { SOUNDS[name](); } catch {}
    },
    get volume() { return volume; },
    setVolume(v) {
      volume = Math.min(1, Math.max(0, +v || 0));
      if (master) master.gain.setTargetAtTime(volume, ctx.currentTime, 0.02);
      try { localStorage.setItem('bc-volume', String(volume)); } catch {}
    },
  };
})();
