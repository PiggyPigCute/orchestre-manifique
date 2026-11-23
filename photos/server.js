// Drive photo public de l'Orchestre Manif'ique.
// Servi derrière nginx sous orchestre-manifique.chruk.fr/photos/ (nginx retire le préfixe
// /photos : ici toutes les routes sont à la racine, et le front utilise des URLs relatives).
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1); // derrière nginx : req.ip et req.secure viennent des en-têtes X-Forwarded-*
app.disable('x-powered-by');

const dataDir = path.join(__dirname, 'data');
const uploadsDir = path.join(__dirname, 'uploads');
const originalsDir = path.join(uploadsDir, 'originals');
const thumbsDir = path.join(uploadsDir, 'thumbs');
const tmpDir = path.join(uploadsDir, '.tmp'); // jamais servi publiquement
const publicDir = path.join(__dirname, 'public');

const eventsPath = path.join(dataDir, 'events.json');
const photosPath = path.join(dataDir, 'photos.json');
const adminPasswordPath = path.join(dataDir, 'admin-password.json');
const sessionSecretPath = path.join(dataDir, 'session-secret');

for (const dir of [dataDir, originalsDir, thumbsDir, tmpDir]) fs.mkdirSync(dir, { recursive: true });

function loadJSON(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

// écriture atomique : un crash en plein milieu ne laisse pas un JSON tronqué
function saveJSON(filePath, data) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

// events : [{ id, date: "YYYY-MM-DD", title }]
// photos : [{ id, eventId, credit, file, thumb, width, height, uploadedAt }]
let events = loadJSON(eventsPath, []);
let photos = loadJSON(photosPath, []);

const saveEvents = () => saveJSON(eventsPath, events);
const savePhotos = () => saveJSON(photosPath, photos);
const sortEvents = () => events.sort((a, b) => a.date.localeCompare(b.date));

/* ---------- Admin : mot de passe unique hashé ---------- */

function loadOrCreateSessionSecret() {
  try {
    return fs.readFileSync(sessionSecretPath, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(sessionSecretPath, secret);
    return secret;
  }
}

const sessionSecret = loadOrCreateSessionSecret();
const ADMIN_COOKIE = 'orma_admin';
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30; // 30 jours

// { "hash": "saltHex:hashHex" } généré via scripts/hash-password.js. Relu à chaque fois :
// changer le mot de passe ne demande pas de redémarrer, et déconnecte les sessions existantes.
function loadAdminPasswordHash() {
  const data = loadJSON(adminPasswordPath, { hash: null });
  return typeof data.hash === 'string' && data.hash.includes(':') ? data.hash : null;
}

function verifyPassword(password, stored) {
  if (typeof password !== 'string' || !password || !stored) return false;
  const [salt, hashHex] = stored.split(':');
  if (!salt || !hashHex) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hashHex, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function sign(value) {
  return crypto.createHmac('sha256', sessionSecret).update(value).digest('hex');
}

// le jeton inclut le hash du mot de passe : changer le mot de passe invalide les anciens jetons
function createAdminToken(hash) {
  const exp = Date.now() + SESSION_MAX_AGE_MS;
  return `${exp}.${sign(`admin:${exp}:${hash}`)}`;
}

function verifyAdminToken(token) {
  if (typeof token !== 'string') return false;
  const [expStr, sig] = token.split('.');
  const exp = Number(expStr);
  if (!sig || !Number.isFinite(exp) || exp < Date.now()) return false;
  const hash = loadAdminPasswordHash();
  if (!hash) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(`admin:${exp}:${hash}`));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookies(req) {
  const cookies = {};
  (req.headers.cookie || '').split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    try {
      cookies[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
    } catch { /* cookie mal formé : ignoré */ }
  });
  return cookies;
}

const isAdmin = req => verifyAdminToken(parseCookies(req)[ADMIN_COOKIE]);

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Connexion admin requise.' });
  next();
}

/* ---------- Limitation de débit (en mémoire, par IP) ---------- */

function rateLimiter({ windowMs, max, message }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.reset < now) hits.delete(key);
  }, windowMs).unref();

  return (req, res, next) => {
    const now = Date.now();
    let entry = hits.get(req.ip);
    if (!entry || entry.reset < now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(req.ip, entry);
    }
    entry.count += 1;
    if (entry.count > max) return res.status(429).json({ error: message });
    next();
  };
}

const loginLimiter = rateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Trop de tentatives, réessaie dans un quart d\'heure.',
});

const uploadLimiter = rateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 1000,
  message: 'Trop de photos envoyées en une heure, réessaie plus tard.',
});

/* ---------- Utilitaires ---------- */

function cleanText(value, maxLength) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

const newId = () => crypto.randomBytes(8).toString('hex');

// type réel d'après les premiers octets (on ne fait pas confiance au mimetype envoyé)
function detectImageType(filePath) {
  const buf = Buffer.alloc(16);
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, 16, 0);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('ascii', 0, 4) === 'GIF8') return 'gif';
  if (buf.toString('ascii', 4, 8) === 'ftyp' && ['avif', 'avis'].includes(buf.toString('ascii', 8, 12))) return 'avif';
  return null;
}

function parseDimension(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 && n < 100000 ? n : null;
}

function publicPhoto(p) {
  return {
    id: p.id,
    eventId: p.eventId,
    credit: p.credit,
    src: `uploads/originals/${p.file}`,
    thumb: `uploads/${p.thumb ? `thumbs/${p.thumb}` : `originals/${p.file}`}`,
    width: p.width,
    height: p.height,
    uploadedAt: p.uploadedAt,
  };
}

function deletePhotoFiles(p) {
  fs.unlink(path.join(originalsDir, p.file), () => {});
  if (p.thumb) fs.unlink(path.join(thumbsDir, p.thumb), () => {});
}

function removePhotos(ids) {
  const toRemove = new Set(ids);
  const removed = photos.filter(p => toRemove.has(p.id));
  if (!removed.length) return 0;
  photos = photos.filter(p => !toRemove.has(p.id));
  savePhotos();
  removed.forEach(deletePhotoFiles);
  return removed.length;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseEventInput(body) {
  const date = String(body?.date ?? '');
  const m = DATE_RE.exec(date);
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  // rejette aussi les dates impossibles type 2026-02-31
  if (!d || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return { error: 'Date invalide.' };
  return { date, title: cleanText(body?.title, 80) };
}

/* ---------- Upload ---------- */

const MAX_FILE_SIZE = 40 * 1024 * 1024; // garder client_max_body_size nginx au-dessus

const upload = multer({
  storage: multer.diskStorage({
    destination: tmpDir,
    filename: (req, file, cb) => cb(null, newId()),
  }),
  limits: { fileSize: MAX_FILE_SIZE, files: 2, fields: 10 },
}).fields([
  { name: 'photo', maxCount: 1 },
  { name: 'thumb', maxCount: 1 },
]);

/* ---------- Routes ---------- */

app.use(express.json({ limit: '100kb' }));

const immutable = { maxAge: '365d', immutable: true, index: false };
app.use('/uploads/originals', express.static(originalsDir, immutable));
app.use('/uploads/thumbs', express.static(thumbsDir, immutable));
app.use(express.static(publicDir));

app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.get('/api/events', (req, res) => {
  res.json(events);
});

app.get('/api/photos', (req, res) => {
  res.json(photos.map(publicPhoto));
});

app.post('/api/photos', uploadLimiter, upload, (req, res) => {
  const photoFile = req.files?.photo?.[0];
  const thumbFile = req.files?.thumb?.[0];
  const fail = (status, error) => {
    for (const f of [photoFile, thumbFile]) if (f) fs.unlink(f.path, () => {});
    res.status(status).json({ error });
  };

  if (!photoFile) return fail(400, 'Aucune photo reçue.');
  const eventId = String(req.body.eventId ?? '');
  if (!events.some(e => e.id === eventId)) return fail(400, 'Choisis une date valide.');
  const credit = cleanText(req.body.credit, 60);
  if (!credit) return fail(400, 'Indique un nom à créditer.');
  const type = detectImageType(photoFile.path);
  if (!type) return fail(415, 'Format non pris en charge (JPEG, PNG, WebP, GIF ou AVIF).');

  const id = newId();
  const file = `${id}.${type}`;
  fs.renameSync(photoFile.path, path.join(originalsDir, file));

  let thumb = null;
  if (thumbFile) {
    const thumbType = detectImageType(thumbFile.path);
    if (thumbType === 'jpg' || thumbType === 'webp') {
      thumb = `${id}.${thumbType}`;
      fs.renameSync(thumbFile.path, path.join(thumbsDir, thumb));
    } else {
      fs.unlink(thumbFile.path, () => {});
    }
  }

  const photo = {
    id,
    eventId,
    credit,
    file,
    thumb,
    width: parseDimension(req.body.width),
    height: parseDimension(req.body.height),
    uploadedAt: new Date().toISOString(),
  };
  photos.push(photo);
  savePhotos();
  res.status(201).json(publicPhoto(photo));
});

app.get('/api/admin/me', (req, res) => {
  res.json({ admin: isAdmin(req), configured: Boolean(loadAdminPasswordHash()) });
});

app.post('/api/admin/login', loginLimiter, (req, res) => {
  const hash = loadAdminPasswordHash();
  if (!hash) return res.status(503).json({ error: 'Aucun mot de passe admin n\'est configuré sur le serveur.' });
  if (!verifyPassword(req.body?.password, hash)) return res.status(401).json({ error: 'Mot de passe incorrect.' });
  res.cookie(ADMIN_COOKIE, createAdminToken(hash), {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure, // pas true en dur : sinon le cookie est ignoré en http:// (tests locaux)
    path: '/',
    maxAge: SESSION_MAX_AGE_MS,
  });
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie(ADMIN_COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.post('/api/admin/photos/delete', requireAdmin, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(id => typeof id === 'string') : [];
  if (!ids.length) return res.status(400).json({ error: 'Aucune photo sélectionnée.' });
  res.json({ deleted: removePhotos(ids) });
});

app.post('/api/admin/events', requireAdmin, (req, res) => {
  const input = parseEventInput(req.body);
  if (input.error) return res.status(400).json({ error: input.error });
  const event = { id: newId(), ...input };
  events.push(event);
  sortEvents();
  saveEvents();
  res.status(201).json(event);
});

app.put('/api/admin/events/:id', requireAdmin, (req, res) => {
  const event = events.find(e => e.id === req.params.id);
  if (!event) return res.status(404).json({ error: 'Évènement introuvable.' });
  const input = parseEventInput(req.body);
  if (input.error) return res.status(400).json({ error: input.error });
  Object.assign(event, input);
  sortEvents();
  saveEvents();
  res.json(event);
});

// refuse si des photos y sont liées, sauf avec ?withPhotos=1 (qui les supprime aussi)
app.delete('/api/admin/events/:id', requireAdmin, (req, res) => {
  const event = events.find(e => e.id === req.params.id);
  if (!event) return res.status(404).json({ error: 'Évènement introuvable.' });
  const linked = photos.filter(p => p.eventId === event.id).map(p => p.id);
  if (linked.length && req.query.withPhotos !== '1') {
    return res.status(409).json({ error: `${linked.length} photo(s) sont liées à cette date.`, count: linked.length });
  }
  removePhotos(linked);
  events = events.filter(e => e.id !== event.id);
  saveEvents();
  res.json({ ok: true, deletedPhotos: linked.length });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Route inconnue.' }));

// erreurs multer (fichier trop lourd...) et JSON mal formé
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const error = err.code === 'LIMIT_FILE_SIZE'
      ? `Photo trop lourde (max ${MAX_FILE_SIZE / 1024 / 1024} Mo).`
      : 'Envoi invalide.';
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Requête invalide.' });
  console.error(err);
  res.status(500).json({ error: 'Erreur serveur.' });
});

const PORT = process.env.PORT || 3010;
app.listen(PORT, () => {
  console.log(`Photos Orchestre Manif'ique sur http://localhost:${PORT}`);
});
