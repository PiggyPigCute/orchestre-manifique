// Génère le hachage du mot de passe admin.
// Usage : node scripts/hash-password.js "motdepasse"
// puis colle la sortie dans data/admin-password.json : { "hash": "<sortie>" }
const crypto = require('crypto');

const password = process.argv[2];
if (!password) {
  console.error('Usage : node scripts/hash-password.js "motdepasse"');
  process.exit(1);
}

const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(password, salt, 64).toString('hex');
console.log(`${salt}:${hash}`);
