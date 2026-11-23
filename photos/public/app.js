'use strict';

// URLs relatives : la page est servie sous /photos/ (nginx retire le préfixe avant le serveur)
const THUMB_MAX = 1000;       // côté max des vignettes générées dans le navigateur
const UPLOAD_CONCURRENCY = 3;
const MAX_FILE_SIZE = 40 * 1024 * 1024;
const CREDIT_KEY = 'orma-credit';

const MONTHS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet',
  'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];

const state = {
  events: [],
  photos: [],
  admin: false,
  filter: 'all',
  queue: [],          // [{ key, file, eventId, autoDate, thumb, status, error }]
  uploading: false,
  selection: new Set(),
  lightboxList: [],
  lightboxIndex: 0,
};

const $ = id => document.getElementById(id);

/* ---------- Utilitaires ---------- */

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
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

function eventLabel(ev) {
  return `${dayLabel(ev.date)} ${ev.date.slice(0, 4)}${ev.title ? ` · ${ev.title}` : ''}`;
}

const eventById = id => state.events.find(e => e.id === id);
const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

let toastTimer;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

async function api(path, options = {}) {
  const opts = { credentials: 'same-origin', ...options };
  if (opts.json !== undefined) {
    opts.headers = { 'Content-Type': 'application/json', ...opts.headers };
    opts.body = JSON.stringify(opts.json);
    delete opts.json;
  }
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch { /* réponse vide */ }
  if (!res.ok) {
    const err = new Error(data?.error || `Erreur ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/* ---------- Chargement ---------- */

async function loadAll() {
  const [events, photos, me] = await Promise.all([
    api('api/events'),
    api('api/photos'),
    api('api/admin/me'),
  ]);
  state.events = events;
  state.photos = photos;
  setAdmin(me.admin);
  renderAll();
}

async function refresh() {
  try {
    const [events, photos] = await Promise.all([api('api/events'), api('api/photos')]);
    state.events = events;
    state.photos = photos;
    renderAll();
  } catch (err) {
    toast(err.message);
  }
}

function renderAll() {
  renderEventSelects();
  renderQueue();
  renderFilters();
  renderGallery();
  if (state.admin) renderEventsAdmin();
}

/* ---------- Lecture de la date EXIF (JPEG) ---------- */

async function readExifDate(file) {
  if (!/jpe?g$/i.test(file.type) && !/\.jpe?g$/i.test(file.name)) return null;
  try {
    const view = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
    if (view.getUint16(0) !== 0xffd8) return null;
    let off = 2;
    while (off + 4 <= view.byteLength) {
      const marker = view.getUint16(off);
      if ((marker & 0xff00) !== 0xff00) return null;
      const len = view.getUint16(off + 2);
      if (marker === 0xffe1 && view.getUint32(off + 4) === 0x45786966) { // "Exif"
        return parseTiffDate(view, off + 10, Math.min(view.byteLength, off + 2 + len));
      }
      if (marker === 0xffda) return null; // début de l'image : plus de métadonnées
      off += 2 + len;
    }
  } catch { /* fichier tronqué ou EXIF bizarre */ }
  return null;
}

function parseTiffDate(view, start, end) {
  const little = view.getUint16(start) === 0x4949;
  const u16 = o => view.getUint16(o, little);
  const u32 = o => view.getUint32(o, little);

  const readIfd = offset => {
    const tags = {};
    const base = start + offset;
    if (base + 2 > end) return tags;
    const count = u16(base);
    for (let i = 0; i < count; i++) {
      const entry = base + 2 + i * 12;
      if (entry + 12 > end) break;
      tags[u16(entry)] = entry;
    }
    return tags;
  };

  const readAscii = entry => {
    const count = u32(entry + 4);
    const at = count > 4 ? start + u32(entry + 8) : entry + 8;
    let s = '';
    for (let i = 0; i < count - 1 && at + i < end; i++) s += String.fromCharCode(view.getUint8(at + i));
    return s;
  };

  const ifd0 = readIfd(u32(start + 4));
  let raw = null;
  if (ifd0[0x8769] != null) {
    const exif = readIfd(u32(ifd0[0x8769] + 8));
    if (exif[0x9003] != null) raw = readAscii(exif[0x9003]); // DateTimeOriginal
  }
  if (!raw && ifd0[0x0132] != null) raw = readAscii(ifd0[0x0132]); // DateTime
  const m = raw && /^(\d{4}):(\d{2}):(\d{2})/.exec(raw);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/* ---------- Vignettes (générées dans le navigateur) ---------- */

async function makeThumb(file) {
  try {
    const bitmap = await createImageBitmap(file); // applique l'orientation EXIF
    const width = bitmap.width;
    const height = bitmap.height;
    const scale = Math.min(1, THUMB_MAX / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    return blob ? { blob, url: URL.createObjectURL(blob), width, height } : null;
  } catch {
    return null; // format que le navigateur ne sait pas décoder : envoyé sans vignette
  }
}

// une seule vignette générée à la fois pour ne pas saturer la mémoire avec 200 photos
let thumbChain = Promise.resolve();
function scheduleThumb(item) {
  thumbChain = thumbChain.then(async () => {
    if (!state.queue.includes(item)) return;
    item.thumb = await makeThumb(item.file);
    item.thumbDone = true;
    updateQueueItem(item);
  });
  item.thumbPromise = thumbChain;
}

/* ---------- File d'envoi ---------- */

const ACCEPTED = /^image\/(jpeg|png|webp|gif|avif)$/;
let queueKey = 0;

async function addFiles(fileList) {
  const files = [...fileList];
  let rejected = 0;
  const defaultEvent = $('defaultEventSelect').value;
  for (const file of files) {
    if (!ACCEPTED.test(file.type) || file.size > MAX_FILE_SIZE) { rejected++; continue; }
    const item = {
      key: ++queueKey,
      file,
      eventId: defaultEvent,
      autoDate: false,
      thumb: null,
      thumbDone: false,
      thumbPromise: null,
      status: 'pending',
      error: '',
    };
    state.queue.push(item);
    scheduleThumb(item);
    readExifDate(file).then(date => {
      const match = date && state.events.find(e => e.date === date);
      if (match && item.status === 'pending') {
        item.eventId = match.id;
        item.autoDate = true;
        updateQueueItem(item);
      }
    });
  }
  if (rejected) {
    toast(`${plural(rejected, 'fichier')} ignoré${rejected > 1 ? 's' : ''} (format non pris en charge ou plus de 40 Mo). Les photos HEIC d'iPhone : choisis « Plus compatible » dans les réglages de l'appareil photo.`);
  }
  renderQueue();
}

function removeFromQueue(item) {
  state.queue = state.queue.filter(i => i !== item);
  if (item.thumb) URL.revokeObjectURL(item.thumb.url);
  renderQueue();
}

function eventOptions(selectedId, { placeholder } = {}) {
  const sorted = [...state.events].sort((a, b) => b.date.localeCompare(a.date));
  const options = sorted.map(ev => h('option', { value: ev.id, selected: ev.id === selectedId }, eventLabel(ev)));
  if (placeholder) options.unshift(h('option', { value: '', selected: !selectedId }, placeholder));
  return options;
}

function renderEventSelects() {
  const select = $('defaultEventSelect');
  const current = select.value;
  const fallback = [...state.events].sort((a, b) => b.date.localeCompare(a.date))[0]?.id || '';
  const selected = eventById(current) ? current : fallback;
  select.replaceChildren(...eventOptions(selected));
  select.disabled = !state.events.length;
  $('noEventsNotice').hidden = state.events.length > 0;
  $('dropzone').hidden = !state.events.length;
}

const STATUS_LABEL = { pending: '', uploading: 'Envoi…', done: 'Envoyée', error: 'Erreur' };

function queueItemEl(item) {
  const thumb = item.thumb
    ? h('img', { src: item.thumb.url, alt: '' })
    : (item.thumbDone ? 'Aperçu indisponible' : 'Préparation…');
  const locked = item.status === 'uploading' || item.status === 'done';
  return h('li', { class: 'queue-item', dataset: { key: item.key, status: item.status } },
    h('div', { class: 'queue-thumb' }, thumb),
    STATUS_LABEL[item.status] && h('span', { class: 'queue-status' }, STATUS_LABEL[item.status]),
    !locked && h('button', {
      class: 'queue-remove', type: 'button', 'aria-label': `Retirer ${item.file.name}`,
      onclick: () => removeFromQueue(item),
    }, '×'),
    h('div', { class: 'queue-body' },
      h('span', { class: 'queue-name', title: item.file.name }, item.file.name),
      h('select', {
        'aria-label': `Date de ${item.file.name}`,
        disabled: locked,
        onchange: e => { item.eventId = e.target.value; item.autoDate = false; updateQueueItem(item); },
      }, eventOptions(item.eventId, { placeholder: 'Choisir une date…' })),
      item.autoDate && h('span', { class: 'queue-auto' }, 'Date trouvée dans la photo'),
      item.error && h('span', { class: 'queue-error' }, item.error),
    ),
  );
}

function updateQueueItem(item) {
  const el = $('queue').querySelector(`[data-key="${item.key}"]`);
  if (el) el.replaceWith(queueItemEl(item));
  renderQueueBar();
}

function renderQueue() {
  // une date supprimée entre-temps n'est plus sélectionnable
  for (const item of state.queue) if (item.eventId && !eventById(item.eventId)) item.eventId = '';
  $('queue').replaceChildren(...state.queue.map(queueItemEl));
  renderQueueBar();
}

function renderQueueBar() {
  const pending = state.queue.filter(i => i.status === 'pending' || i.status === 'error');
  const done = state.queue.filter(i => i.status === 'done').length;
  $('queueBar').hidden = state.queue.length === 0;
  $('queueSummary').textContent = state.uploading
    ? `Envoi en cours… ${done} / ${state.queue.length}`
    : `${plural(pending.length, 'photo')} prête${pending.length > 1 ? 's' : ''} à envoyer`;
  $('sendBtn').textContent = pending.length ? `Envoyer ${plural(pending.length, 'photo')}` : 'Envoyer';
  $('sendBtn').disabled = state.uploading || pending.length === 0;
  $('clearQueueBtn').disabled = state.uploading;
}

function showUploadError(message) {
  $('uploadError').textContent = message;
  $('uploadError').hidden = !message;
}

async function uploadItem(item, credit) {
  item.status = 'uploading';
  item.error = '';
  updateQueueItem(item);
  await item.thumbPromise; // attend sa vignette si elle n'est pas encore prête
  const form = new FormData();
  form.append('eventId', item.eventId);
  form.append('credit', credit);
  if (item.thumb) {
    form.append('width', item.thumb.width);
    form.append('height', item.thumb.height);
  }
  form.append('photo', item.file, item.file.name);
  if (item.thumb) form.append('thumb', item.thumb.blob, 'thumb.jpg');
  try {
    await api('api/photos', { method: 'POST', body: form });
    item.status = 'done';
  } catch (err) {
    item.status = 'error';
    item.error = err.message;
  }
  updateQueueItem(item);
}

async function sendQueue() {
  const credit = $('creditInput').value.trim();
  const toSend = state.queue.filter(i => i.status === 'pending' || i.status === 'error');
  if (!credit) {
    showUploadError('Indique le nom à créditer avant d\'envoyer.');
    $('creditInput').focus();
    return;
  }
  if (toSend.some(i => !i.eventId)) {
    showUploadError('Chaque photo doit avoir une date.');
    return;
  }
  showUploadError('');
  try { localStorage.setItem(CREDIT_KEY, credit); } catch { /* stockage indisponible */ }

  state.uploading = true;
  renderQueueBar();
  $('progress').hidden = false;
  let finished = 0;
  const setProgress = () => { $('progressFill').style.width = `${(finished / toSend.length) * 100}%`; };
  setProgress();

  const pool = [...toSend];
  const worker = async () => {
    while (pool.length) {
      await uploadItem(pool.shift(), credit);
      finished++;
      setProgress();
    }
  };
  await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, worker));

  state.uploading = false;
  const sent = toSend.filter(i => i.status === 'done');
  const failed = toSend.length - sent.length;
  // les photos envoyées quittent la file ; celles en erreur restent pour pouvoir réessayer
  sent.forEach(i => i.thumb && URL.revokeObjectURL(i.thumb.url));
  state.queue = state.queue.filter(i => i.status !== 'done');
  setTimeout(() => { $('progress').hidden = true; }, 800);
  toast(failed
    ? `${plural(sent.length, 'photo')} envoyée(s), ${failed} en erreur.`
    : `Merci ! ${plural(sent.length, 'photo')} ajoutée${sent.length > 1 ? 's' : ''}.`);
  await refresh();
}

/* ---------- Galerie ---------- */

function photosByEvent() {
  const groups = new Map();
  for (const photo of state.photos) {
    if (!groups.has(photo.eventId)) groups.set(photo.eventId, []);
    groups.get(photo.eventId).push(photo);
  }
  return groups;
}

function renderFilters() {
  const groups = photosByEvent();
  if (state.filter !== 'all' && !eventById(state.filter)) state.filter = 'all';
  const chip = (id, label, count) => h('button', {
    class: 'chip', type: 'button', role: 'tab',
    'aria-selected': String(state.filter === id),
    onclick: () => { state.filter = id; renderFilters(); renderGallery(); },
  }, label, h('small', {}, count));
  const sorted = [...state.events].sort((a, b) => b.date.localeCompare(a.date));
  $('filterChips').replaceChildren(
    chip('all', 'Toutes', state.photos.length),
    ...sorted.map(ev => chip(ev.id, dayLabel(ev.date) + (ev.title ? ` · ${ev.title}` : ''), groups.get(ev.id)?.length || 0)),
  );
}

function tileEl(photo, index, list) {
  const ev = eventById(photo.eventId);
  const selected = state.selection.has(photo.id);
  return h('figure', {
    class: `tile${selected ? ' selected' : ''}`,
    onclick: () => openLightbox(list, index),
  },
  h('img', {
    src: photo.thumb, alt: `Photo de ${photo.credit}${ev ? `, ${dayLabel(ev.date)}` : ''}`,
    loading: 'lazy', decoding: 'async',
  }),
  h('figcaption', {}, `© ${photo.credit}`),
  state.admin && h('input', {
    class: 'tile-check', type: 'checkbox', checked: selected,
    'aria-label': `Sélectionner la photo de ${photo.credit}`,
    onclick: e => e.stopPropagation(),
    onchange: e => {
      toggleSelection(photo.id, e.target.checked);
      e.target.closest('.tile').classList.toggle('selected', e.target.checked);
      renderSelectionBar();
    },
  }));
}

function renderGallery() {
  const groups = photosByEvent();
  const events = [...state.events]
    .sort((a, b) => b.date.localeCompare(a.date))
    .filter(ev => (state.filter === 'all' || state.filter === ev.id) && groups.get(ev.id)?.length);

  const sections = events.map(ev => {
    const list = groups.get(ev.id).sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt));
    const allSelected = () => list.every(p => state.selection.has(p.id));
    return h('section', { class: 'group' },
      h('div', { class: 'group-head' },
        h('span', { class: 'group-date' }, dayLabel(ev.date), h('span', { class: 'year' }, ev.date.slice(0, 4))),
        ev.title && h('span', { class: 'group-title' }, ev.title),
        h('span', { class: 'group-count' }, plural(list.length, 'photo')),
        state.admin && h('button', {
          class: 'btn btn-ghost btn-small', type: 'button',
          onclick: () => { const on = !allSelected(); list.forEach(p => toggleSelection(p.id, on)); renderGallery(); },
        }, allSelected() ? 'Tout désélectionner' : 'Tout sélectionner'),
      ),
      h('div', { class: 'grid' }, list.map((p, i) => tileEl(p, i, list))),
    );
  });

  $('gallery').replaceChildren(...sections);
  $('galleryEmpty').hidden = sections.length > 0;
  renderSelectionBar();
}

/* ---------- Visionneuse ---------- */

function openLightbox(list, index) {
  state.lightboxList = list;
  state.lightboxIndex = index;
  showLightboxPhoto();
  if (!$('lightbox').open) $('lightbox').showModal();
}

function showLightboxPhoto() {
  const list = state.lightboxList;
  const photo = list[state.lightboxIndex];
  if (!photo) { $('lightbox').close(); return; }
  const ev = eventById(photo.eventId);
  const img = $('lbImg');
  img.src = photo.thumb;              // vignette tout de suite…
  const full = new Image();           // …puis l'original dès qu'il est chargé
  full.onload = () => { if (list[state.lightboxIndex] === photo) img.src = photo.src; };
  full.src = photo.src;
  img.alt = `Photo de ${photo.credit}`;
  $('lbCaption').textContent = `© ${photo.credit}${ev ? ` — ${eventLabel(ev)}` : ''}`;
  $('lbDownload').href = photo.src;
  $('lbDownload').setAttribute('download', `orchestre-manifique-${ev?.date || 'photo'}-${photo.id}${photo.src.slice(photo.src.lastIndexOf('.'))}`);
  $('lbDelete').hidden = !state.admin;
  $('lbPrev').hidden = list.length < 2;
  $('lbNext').hidden = list.length < 2;
}

function stepLightbox(delta) {
  const n = state.lightboxList.length;
  if (n < 2) return;
  state.lightboxIndex = (state.lightboxIndex + delta + n) % n;
  showLightboxPhoto();
}

/* ---------- Admin ---------- */

function setAdmin(admin) {
  state.admin = admin;
  $('adminBadge').hidden = !admin;
  $('adminBtn').textContent = admin ? 'Déconnexion' : 'Admin';
  $('eventsAdmin').hidden = !admin;
  if (!admin) state.selection.clear();
}

function toggleSelection(id, on) {
  if (on) state.selection.add(id); else state.selection.delete(id);
}

function renderSelectionBar() {
  // ne garder que des photos encore existantes
  for (const id of state.selection) if (!state.photos.some(p => p.id === id)) state.selection.delete(id);
  const n = state.selection.size;
  $('adminToolbar').hidden = !state.admin;
  $('selectionCount').textContent = `${n} sélectionnée${n > 1 ? 's' : ''}`;
  $('deleteSelectionBtn').disabled = n === 0;
  $('clearSelectionBtn').disabled = n === 0;
}

async function deletePhotos(ids) {
  if (!ids.length) return false;
  if (!confirm(`Supprimer définitivement ${plural(ids.length, 'photo')} ?`)) return false;
  try {
    const { deleted } = await api('api/admin/photos/delete', { method: 'POST', json: { ids } });
    ids.forEach(id => state.selection.delete(id));
    toast(`${plural(deleted, 'photo')} supprimée${deleted > 1 ? 's' : ''}.`);
    await refresh();
    return true;
  } catch (err) {
    handleAdminError(err);
    return false;
  }
}

function handleAdminError(err) {
  if (err.status === 401) {
    setAdmin(false);
    renderAll();
    toast('Session admin expirée, reconnecte-toi.');
  } else {
    toast(err.message);
  }
}

function renderEventsAdmin() {
  const counts = photosByEvent();
  const rows = [...state.events].sort((a, b) => b.date.localeCompare(a.date)).map(ev => {
    const dateInput = h('input', { type: 'date', value: ev.date, required: true, 'aria-label': 'Date' });
    const titleInput = h('input', { type: 'text', value: ev.title || '', maxlength: '80', placeholder: 'Intitulé (facultatif)', 'aria-label': 'Intitulé' });
    const count = counts.get(ev.id)?.length || 0;
    return h('li', { class: 'event-row' },
      dateInput,
      titleInput,
      h('span', { class: 'event-count' }, plural(count, 'photo')),
      h('button', {
        class: 'btn btn-ghost btn-small', type: 'button',
        onclick: async () => {
          try {
            await api(`api/admin/events/${ev.id}`, { method: 'PUT', json: { date: dateInput.value, title: titleInput.value } });
            toast('Date enregistrée.');
            await refresh();
          } catch (err) { handleAdminError(err); }
        },
      }, 'Enregistrer'),
      h('button', {
        class: 'btn btn-danger btn-small', type: 'button',
        onclick: () => deleteEvent(ev, count),
      }, 'Supprimer'),
    );
  });
  $('eventRows').replaceChildren(...rows);
}

async function deleteEvent(ev, count) {
  const message = count
    ? `Supprimer « ${eventLabel(ev)} » ET ses ${plural(count, 'photo')} ? C'est définitif.`
    : `Supprimer « ${eventLabel(ev)} » ?`;
  if (!confirm(message)) return;
  try {
    await api(`api/admin/events/${ev.id}${count ? '?withPhotos=1' : ''}`, { method: 'DELETE' });
    toast('Date supprimée.');
    await refresh();
  } catch (err) {
    handleAdminError(err);
  }
}

/* ---------- Évènements DOM ---------- */

function bindUi() {
  try { $('creditInput').value = localStorage.getItem(CREDIT_KEY) || ''; } catch { /* stockage indisponible */ }

  $('fileInput').addEventListener('change', e => {
    addFiles(e.target.files);
    e.target.value = '';
  });

  const dz = $('dropzone');
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', e => {
    e.preventDefault();
    dz.classList.remove('dragover');
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });

  // « date par défaut » : l'appliquer aux photos en attente dont la date n'a pas été trouvée/choisie
  $('defaultEventSelect').addEventListener('change', e => {
    for (const item of state.queue) if (item.status === 'pending' && !item.autoDate) item.eventId = e.target.value;
    renderQueue();
  });

  $('sendBtn').addEventListener('click', sendQueue);
  $('clearQueueBtn').addEventListener('click', () => {
    state.queue.forEach(i => i.thumb && URL.revokeObjectURL(i.thumb.url));
    state.queue = [];
    showUploadError('');
    renderQueue();
  });

  window.addEventListener('beforeunload', e => {
    if (state.uploading) { e.preventDefault(); e.returnValue = ''; }
  });

  // visionneuse
  $('lbClose').addEventListener('click', () => $('lightbox').close());
  $('lbPrev').addEventListener('click', () => stepLightbox(-1));
  $('lbNext').addEventListener('click', () => stepLightbox(1));
  $('lightbox').addEventListener('click', e => { if (e.target === $('lightbox')) $('lightbox').close(); });
  $('lightbox').addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft') stepLightbox(-1);
    if (e.key === 'ArrowRight') stepLightbox(1);
  });
  let touchX = null;
  $('lightbox').addEventListener('touchstart', e => { touchX = e.touches[0].clientX; }, { passive: true });
  $('lightbox').addEventListener('touchend', e => {
    if (touchX == null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 50) stepLightbox(dx < 0 ? 1 : -1);
    touchX = null;
  });
  $('lbDelete').addEventListener('click', async () => {
    const photo = state.lightboxList[state.lightboxIndex];
    if (photo && await deletePhotos([photo.id])) $('lightbox').close();
  });

  // admin
  $('adminBtn').addEventListener('click', async () => {
    if (state.admin) {
      await api('api/admin/logout', { method: 'POST' }).catch(() => {});
      setAdmin(false);
      renderAll();
      toast('Déconnecté·e.');
      return;
    }
    $('loginError').hidden = true;
    $('passwordInput').value = '';
    $('loginDialog').showModal();
  });
  $('loginCancel').addEventListener('click', () => $('loginDialog').close());
  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api('api/admin/login', { method: 'POST', json: { password: $('passwordInput').value } });
      $('loginDialog').close();
      setAdmin(true);
      renderAll();
      toast('Connecté·e en admin.');
    } catch (err) {
      $('loginError').textContent = err.message;
      $('loginError').hidden = false;
    }
  });

  $('clearSelectionBtn').addEventListener('click', () => { state.selection.clear(); renderGallery(); });
  $('deleteSelectionBtn').addEventListener('click', () => deletePhotos([...state.selection]));

  $('newEventForm').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.target;
    const field = name => form.elements.namedItem(name).value; // form.title = attribut natif du <form>
    try {
      await api('api/admin/events', { method: 'POST', json: { date: field('date'), title: field('title') } });
      form.reset();
      toast('Date ajoutée.');
      await refresh();
    } catch (err) {
      handleAdminError(err);
    }
  });
}

bindUi();
loadAll().catch(err => toast(`Impossible de charger les photos : ${err.message}`));
