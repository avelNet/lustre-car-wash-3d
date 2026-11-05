import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from 'lenis';
import { createScene, dirtUniforms } from './scene.js';

gsap.registerPlugin(ScrollTrigger);

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const EASE = 'expo.out';

/* ---------- Smooth scroll ---------- */
let lenis = null;
if (!reduceMotion) {
  lenis = new Lenis({ lerp: 0.09 });
  lenis.on('scroll', ScrollTrigger.update);
  gsap.ticker.add((t) => lenis.raf(t * 1000));
  gsap.ticker.lagSmoothing(0);
}

function scrollToY(y) {
  if (lenis) lenis.scrollTo(y, { duration: 1.6 });
  else window.scrollTo({ top: y, behavior: reduceMotion ? 'auto' : 'smooth' });
}

/* ---------- Story timeline ---------- */
// Positions on the 0..10 timeline where each stage starts, used for nav links and the HUD
const STAGES = [
  { at: 0, name: 'Drop off' },
  { at: 1.2, name: 'Hand wash' },
  { at: 5.0, name: 'Inspection' },
  { at: 6.9, name: 'Polish · Ceramic' },
  { at: 9.0, name: 'Pick up' },
];
const TOTAL = 10;
const story = document.getElementById('story');
const scenes = [...document.querySelectorAll('.scene')];

// wrap each heading line so it can slide up out of a mask
scenes.forEach((s) => s.querySelectorAll('.line').forEach((l) => { l.innerHTML = `<span>${l.textContent}</span>`; }));

function storyScrollFor(at) {
  const range = story.offsetHeight - window.innerHeight;
  return story.offsetTop + (at / TOTAL) * range + 2;
}

document.querySelectorAll('a[href^="#"]').forEach((a) => {
  a.addEventListener('click', (e) => {
    const id = a.getAttribute('href').slice(1);
    const stage = a.dataset.stage ?? { wash: 1, polish: 2, ceramic: 3, pickup: 4 }[id];
    const target = id && document.getElementById(id);
    if (stage === undefined && !target) return;
    e.preventDefault();
    closeMenu();
    if (stage !== undefined) scrollToY(storyScrollFor(STAGES[stage].at + 0.35));
    else if (id === 'top') scrollToY(0);
    else scrollToY(target.getBoundingClientRect().top + window.scrollY);
  });
});

/* ---------- HUD + nav state ---------- */
const hud = document.getElementById('hud');
const hudStage = document.getElementById('hudStage');
const hudName = document.getElementById('hudName');
const hudFill = document.getElementById('hudFill');
const navLinks = [...document.querySelectorAll('.nav__links a')];
let currentStage = -1;
function updateHud(t) {
  let i = 0;
  STAGES.forEach((s, k) => { if (t >= s.at) i = k; });
  hudFill.style.transform = `scaleX(${t / TOTAL})`;
  if (i === currentStage) return;
  currentStage = i;
  hudStage.textContent = `0${i + 1} / 0${STAGES.length}`;
  hudName.textContent = STAGES[i].name;
  navLinks.forEach((a) => a.classList.toggle('is-active', +a.dataset.stage === i));
}

/* ---------- Loader ---------- */
const loaderEl = document.getElementById('loader');
const loaderFill = document.getElementById('loaderFill');
const loaderPct = document.getElementById('loaderPct');
function setLoad(p) {
  loaderFill.style.transform = `scaleX(${p})`;
  loaderPct.textContent = `${Math.round(p * 100)}%`;
}

function sceneIn(tl, i, at) {
  const el = scenes[i];
  tl.set(el, { autoAlpha: 1 }, at);
  tl.fromTo(el.querySelectorAll('.line > span'), { yPercent: 110 }, { yPercent: 0, duration: 0.35, stagger: 0.08, ease: EASE }, at);
  tl.fromTo(el.querySelector('.scene__sub'), { autoAlpha: 0, y: 24 }, { autoAlpha: 1, y: 0, duration: 0.3, ease: EASE }, at + 0.12);
}
function sceneOut(tl, i, at) {
  const el = scenes[i];
  tl.to(el.querySelectorAll('.line > span'), { yPercent: -110, duration: 0.25, stagger: 0.05, ease: 'power2.in' }, at);
  tl.to(el.querySelector('.scene__sub'), { autoAlpha: 0, duration: 0.2 }, at);
  tl.set(el, { autoAlpha: 0 }, at + 0.35);
}

async function init() {
  const canvas = document.getElementById('gl');
  let world;
  try {
    world = await createScene(canvas, { onProgress: (p) => setLoad(p * 0.95) });
  } catch (err) {
    console.error(err);
    loaderEl.classList.add('is-error');
    loaderEl.querySelector('.loader__label').textContent = '3D scene failed to load. The page still works.';
    setTimeout(() => loaderEl.classList.add('is-done'), 2200);
    gsap.set(scenes[0], { autoAlpha: 1 });
    return;
  }
  setLoad(1);
  if (import.meta.env.DEV) window.__world = world;

  const { camPos, camTarget, state, dims, hood, door, setBeads, render } = world;
  const portrait = () => window.innerWidth < window.innerHeight;

  // Camera shots. Front of the car faces +z, camera on +x, so the wash runs left to right on screen.
  const P = (x, y, z) => ({ x, y, z });
  const shots = {
    hero: { pos: P(7.6, 1.1, 4.2), tgt: P(0, 0.85, -0.1) },
    wash: { pos: P(6.4, 1.0, 3.0), tgt: P(0, 0.7, -0.2) },
    door: { pos: P(door.x + 0.55, door.y + 0.18, door.z + 1.7), tgt: P(door.x - 0.05, door.y, door.z - 0.6) },
    door2: { pos: P(door.x + 0.42, door.y + 0.12, door.z + 0.9), tgt: P(door.x - 0.05, door.y - 0.02, door.z - 1.1) },
    // looking down onto the hood so the ceiling bars streak across the paint
    hood: { pos: P(hood.x + 0.6, hood.y + 0.85, hood.z - 0.35), tgt: P(hood.x - 0.15, hood.y, hood.z + 0.2) },
    hood2: { pos: P(hood.x + 0.38, hood.y + 0.55, hood.z - 0.18), tgt: P(hood.x - 0.15, hood.y, hood.z + 0.2) },
    keys: { pos: P(4.1, 0.5, 5.2), tgt: P(0, 0.62, 0) },
    keys2: { pos: P(3.2, 0.42, 4.6), tgt: P(0, 0.66, -0.2) },
  };
  // pull wide shots back on portrait screens
  const widen = (s) => {
    if (!portrait()) return s;
    const f = 1.45;
    return { pos: P(s.pos.x * f, s.pos.y * 1.2, s.pos.z * f), tgt: s.tgt };
  };
  for (const k of ['hero', 'wash', 'keys', 'keys2']) shots[k] = widen(shots[k]);

  const cam = { px: 0, py: 0, pz: 0, tx: 0, ty: 0, tz: 0 };
  const put = (s) => ({ px: s.pos.x, py: s.pos.y, pz: s.pos.z, tx: s.tgt.x, ty: s.tgt.y, tz: s.tgt.z });
  Object.assign(cam, put(shots.hero));

  const fx = { wash: dims.maxZ + 0.8, foam: 0, spray: 0, swirl: 0, beads: 0, warm: 0, cut: 0, t: 0 };
  const cut = document.createElement('div');
  cut.style.cssText = 'position:fixed;inset:0;background:#000;pointer-events:none;z-index:1;opacity:0';
  document.body.appendChild(cut);

  const tl = gsap.timeline({ defaults: { ease: 'none' }, paused: true });
  tl.to(fx, { t: TOTAL, duration: TOTAL }, 0);

  // 0 → 1.2  hero, slow drift
  tl.to(cam, { ...put(shots.wash), duration: 4, ease: 'power1.inOut' }, 0.2);
  sceneOut(tl, 0, 1.0);

  // 1.2 → 4.6  wash sweeps front to back
  sceneIn(tl, 1, 1.35);
  tl.to(fx, { foam: 1, spray: 1, duration: 0.3 }, 1.25);
  tl.to(fx, { wash: dims.minZ - 0.8, duration: 2.8, ease: 'power1.inOut' }, 1.3);
  tl.to(fx, { spray: 0, duration: 0.3 }, 3.9);
  tl.to(fx, { foam: 0, duration: 0.5 }, 4.0);
  sceneOut(tl, 1, 4.4);

  // cut to the door panel under inspection light, swirls visible
  tl.to(fx, { cut: 1, duration: 0.25 }, 4.6);
  tl.set(cam, put(shots.door), 4.86);
  tl.set(fx, { swirl: 1 }, 4.86);
  tl.to(fx, { cut: 0, duration: 0.3 }, 4.9);
  sceneIn(tl, 2, 5.05);
  tl.to(cam, { ...put(shots.door2), duration: 1.6, ease: 'power1.inOut' }, 4.9);
  sceneOut(tl, 2, 6.4);

  // cut to the hood: polish removes swirls, beads form
  tl.to(fx, { cut: 1, duration: 0.25 }, 6.55);
  tl.set(cam, put(shots.hood), 6.81);
  tl.to(fx, { cut: 0, duration: 0.3 }, 6.85);
  sceneIn(tl, 3, 6.95);
  tl.to(fx, { swirl: 0, duration: 0.9, ease: 'power1.inOut' }, 7.0);
  tl.to(fx, { beads: 1, duration: 0.9 }, 7.6);
  tl.to(cam, { ...put(shots.hood2), duration: 1.75, ease: 'power1.inOut' }, 6.85);
  sceneOut(tl, 3, 8.45);

  // cut to golden hour pick up
  tl.to(fx, { cut: 1, duration: 0.25 }, 8.6);
  tl.set(cam, put(shots.keys), 8.86);
  tl.set(fx, { warm: 1, beads: 0 }, 8.86);
  tl.to(fx, { cut: 0, duration: 0.35 }, 8.9);
  sceneIn(tl, 4, 9.05);
  tl.to(cam, { ...put(shots.keys2), duration: 1.1, ease: 'power1.out' }, 8.9);

  ScrollTrigger.create({
    trigger: story,
    start: 'top top',
    end: 'bottom bottom',
    scrub: reduceMotion ? true : 0.6,
    animation: tl,
    onToggle: (self) => {
      hud.classList.toggle('is-hidden', !self.isActive);
      if (!self.isActive) navLinks.forEach((a) => a.classList.remove('is-active'));
      currentStage = -1;
    },
  });

  // first scene is on screen from the start
  gsap.set(scenes[0], { autoAlpha: 1 });
  gsap.from(scenes[0].querySelectorAll('.line > span'), { yPercent: 110, duration: 1.2, stagger: 0.12, ease: EASE, delay: 0.4 });
  gsap.from(scenes[0].querySelector('.scene__sub'), { autoAlpha: 0, y: 24, duration: 1, ease: EASE, delay: 0.7 });

  // Only render while the story is on screen; the sections below cover the canvas
  let storyVisible = true;
  let lastKey = '';
  new IntersectionObserver(([e]) => { storyVisible = e.isIntersecting; }, { rootMargin: '0px 0px 0px 0px' }).observe(story);

  gsap.ticker.add(() => {
    dirtUniforms.uWash.value = fx.wash;
    dirtUniforms.uFoam.value = fx.foam;
    dirtUniforms.uSwirl.value = fx.swirl;
    state.sprayOpacity = fx.spray;
    state.warm = fx.warm;
    setBeads(fx.beads);
    cut.style.opacity = fx.cut;
    camPos.set(cam.px, cam.py, cam.pz);
    camTarget.set(cam.tx, cam.ty, cam.tz);
    updateHud(fx.t);
    // Render only when something moved; the spray is the one thing that animates on its own
    if (!storyVisible) return;
    const key = `${cam.px},${cam.py},${cam.pz},${cam.tx},${cam.ty},${cam.tz},${fx.wash},${fx.foam},${fx.swirl},${fx.beads},${fx.warm},${innerWidth},${innerHeight}`;
    if (key === lastKey && fx.spray < 0.01) return;
    lastKey = key;
    render();
  });

  window.addEventListener('resize', () => ScrollTrigger.refresh());

  render();
  requestAnimationFrame(() => loaderEl.classList.add('is-done'));
}

/* ---------- Tagline: words light up one at a time ---------- */
const tagline = document.getElementById('tagline');
const words = tagline.textContent.trim().split(/\s+/);
tagline.innerHTML = words.map((w) => `<span class="w">${w}</span>`).join(' ');
const wordEls = [...tagline.querySelectorAll('.w')];
if (!reduceMotion) {
  ScrollTrigger.create({
    trigger: tagline,
    start: 'top 80%',
    end: 'bottom 45%',
    onUpdate: (self) => {
      const n = Math.round(self.progress * wordEls.length);
      wordEls.forEach((w, i) => w.classList.toggle('is-on', i < n));
    },
  });
}

/* ---------- Section reveals ---------- */
const io = new IntersectionObserver((entries) => {
  entries.forEach((e) => {
    if (!e.isIntersecting) return;
    e.target.classList.add('is-in');
    io.unobserve(e.target);
  });
}, { threshold: 0.15 });
document.querySelectorAll('.reveal').forEach((el, i) => {
  el.style.transitionDelay = `${(i % 3) * 80}ms`;
  io.observe(el);
});

/* ---------- Mobile menu ---------- */
const toggle = document.getElementById('menuToggle');
const menu = document.getElementById('mobileMenu');
function closeMenu() {
  if (menu.hidden) return;
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-label', 'Open menu');
  menu.classList.remove('is-open');
  menu.hidden = true;
  lenis?.start();
}
toggle.addEventListener('click', () => {
  if (!menu.hidden) return closeMenu();
  menu.hidden = false;
  toggle.setAttribute('aria-expanded', 'true');
  toggle.setAttribute('aria-label', 'Close menu');
  [...menu.children].forEach((a, i) => { a.style.transitionDelay = `${Math.min(i * 60, 400)}ms`; });
  requestAnimationFrame(() => menu.classList.add('is-open'));
  lenis?.stop();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

/* ---------- Booking form ---------- */
const form = document.getElementById('bookingForm');
const status = document.getElementById('formStatus');
const dateInput = document.getElementById('fDate');
const today = new Date();
today.setDate(today.getDate() + 1);
dateInput.min = today.toISOString().slice(0, 10);

const rules = {
  name: (v) => (v.trim().length >= 2 ? '' : 'Enter your name so we know who to call.'),
  email: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()) ? '' : 'Enter an email like name@example.com.'),
  date: (v) => (!v ? 'Pick a drop off date.' : v < dateInput.min ? 'Pick a date from tomorrow onwards.' : ''),
};
function validateField(input) {
  const rule = rules[input.name];
  if (!rule) return true;
  const msg = rule(input.value);
  const field = input.closest('.field');
  field.classList.toggle('has-error', !!msg);
  field.querySelector('.field__error').textContent = msg;
  input.setAttribute('aria-invalid', msg ? 'true' : 'false');
  return !msg;
}
form.querySelectorAll('input[name]').forEach((input) => {
  input.addEventListener('blur', () => input.value && validateField(input));
  input.addEventListener('input', () => input.closest('.field')?.classList.contains('has-error') && validateField(input));
});
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const inputs = [...form.querySelectorAll('input[name="name"], input[name="email"], input[name="date"]')];
  const ok = inputs.map(validateField).every(Boolean);
  if (!ok) {
    inputs.find((i) => i.getAttribute('aria-invalid') === 'true')?.focus();
    status.classList.remove('is-success');
    status.textContent = 'Check the highlighted fields.';
    return;
  }
  const data = Object.fromEntries(new FormData(form));
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = 'Sending request';
  setTimeout(() => {
    try {
      const list = JSON.parse(localStorage.getItem('lustre-bookings') || '[]');
      list.push({ ...data, created: new Date().toISOString() });
      localStorage.setItem('lustre-bookings', JSON.stringify(list));
    } catch { /* storage can be blocked, the confirmation still shows */ }
    const when = new Date(data.date + 'T00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    status.classList.add('is-success');
    status.textContent = `Request saved for ${data.service}, ${when}. We confirm by email within two hours.`;
    btn.disabled = false;
    btn.textContent = 'Request a slot';
    form.reset();
  }, 700);
});

init();
