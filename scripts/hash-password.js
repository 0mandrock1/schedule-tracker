// One-off helper: prints a scrypt hash for a password.
// Usage: node scripts/hash-password.js <password>
const crypto = require('crypto');

const password = process.argv[2];
if (!password) {
  console.error('usage: node scripts/hash-password.js <password>');
  process.exit(1);
}

const salt = crypto.randomBytes(16);
const derived = crypto.scryptSync(password, salt, 64);
console.log(`scrypt:${salt.toString('hex')}:${derived.toString('hex')}`);
