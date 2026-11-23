'use strict';

// le drive photo est servi sur le même domaine, sous /photos/
const DRIVE = '/photos/';
const MAX_PHOTOS_PER_BAND = 20;  // tirées au hasard parmi les photos de la journée
const MIN_ITEMS_PER_HALF = 6;    // assez de photos pour remplir la largeur avant la boucle
const SECONDS_PER_PHOTO = 5;
const ORIGIN_DATE = '2026-11-03';

const MONTHS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet',
  'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style') Object.assign(el.style, value);
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

function dayLabel(date) {
  const [, m, d] = date.split('-').map(Number);
  return `${d === 1 ? '1er' : d} ${MONTHS[m - 1]}`;
}

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// les images ne sont chargées qu'à l'approche de leur bandeau
const lazyObserver = 'IntersectionObserver' in window
  ? new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.querySelectorAll('img[data-src]').forEach(img => {
        img.src = img.dataset.src;
        img.removeAttribute('data-src');
      });
      lazyObserver.unobserve(entry.target);
    }
  }, { rootMargin: '400px 0px' })
  : null;

function photoEl(photo, hidden) {
  const ratio = photo.width && photo.height ? photo.width / photo.height : 4 / 3;
  const src = DRIVE + photo.thumb;
  return h('figure', { class: 'tl-photo', 'aria-hidden': hidden ? 'true' : null },
    h('img', {
      alt: hidden ? '' : `Photo de ${photo.credit}`,
      decoding: 'async',
      style: { aspectRatio: String(ratio) },
      ...(lazyObserver ? { 'data-src': src } : { src }),
    }),
    h('figcaption', {}, `© ${photo.credit}`),
  );
}

function bandEl(event, photos) {
  const label = h('div', { class: 'tl-label' },
    h('span', { class: 'tl-date' }, dayLabel(event.date), h('span', { class: 'tl-year' }, event.date.slice(0, 4))),
    event.title && h('span', { class: 'tl-title' }, event.title),
    event.date > todayIso() && h('span', { class: 'tl-tag' }, 'À venir'),
  );

  if (!photos.length) {
    return h('a', { class: 'tl-band is-empty', href: DRIVE },
      label,
      event.date <= todayIso() && h('span', { class: 'tl-empty-text' }, 'Pas encore de photos : ajoute les tiennes'),
    );
  }

  let half = shuffle(photos).slice(0, MAX_PHOTOS_PER_BAND);
  // peu de photos : on les répète pour que la piste couvre toute la largeur
  while (half.length < MIN_ITEMS_PER_HALF) half = half.concat(shuffle(photos));

  // la piste contient deux fois la même suite et défile de -50% : la boucle est invisible
  const track = h('div', { class: 'tl-track', style: { animationDuration: `${half.length * SECONDS_PER_PHOTO}s` } },
    half.map((p, i) => photoEl(p, i >= photos.length)),
    half.map(p => photoEl(p, true)),
  );

  const band = h('a', {
    class: 'tl-band',
    href: DRIVE,
    'aria-label': `${dayLabel(event.date)} ${event.date.slice(0, 4)}${event.title ? `, ${event.title}` : ''} : voir les photos`,
  }, track, label);
  if (lazyObserver) lazyObserver.observe(band);
  return band;
}

function originEl() {
  const [y] = ORIGIN_DATE.split('-');
  return h('li', { class: 'tl-item tl-origin' },
    h('img', { class: 'tl-origin-logo', src: 'img/logo.png', width: '900', height: '462', alt: '' }),
    h('div', {},
      h('div', { class: 'tl-origin-date' }, dayLabel(ORIGIN_DATE), ' ', h('span', {}, y)),
      h('p', {}, 'Naissance de l\'Orchestre Manif\'ique'),
    ),
  );
}

async function buildTimeline() {
  const timeline = document.getElementById('timeline');
  try {
    const [events, photos] = await Promise.all([
      fetch(`${DRIVE}api/events`).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
      fetch(`${DRIVE}api/photos`).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
    ]);

    const byEvent = new Map();
    for (const p of photos) {
      if (!byEvent.has(p.eventId)) byEvent.set(p.eventId, []);
      byEvent.get(p.eventId).push(p);
    }

    // de bas en haut : la plus ancienne en bas, juste au-dessus de la naissance de l'orchestre
    const items = [...events]
      .sort((a, b) => b.date.localeCompare(a.date))
      .map(ev => h('li', { class: 'tl-item' }, bandEl(ev, byEvent.get(ev.id) || [])));

    timeline.replaceChildren(...items, originEl());
  } catch {
    timeline.replaceChildren(
      h('li', { class: 'timeline-error' }, 'La frise n\'a pas pu être chargée pour le moment.'),
      originEl(),
    );
  }
}

buildTimeline();
