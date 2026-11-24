const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { createHash, scrypt, timingSafeEqual } = require('crypto');
const { listTimeline } = require('./history');

const deriveKey = promisify(scrypt);

function createAccess(archiveDir, filename = process.env.TIMECAPSULE_USERS_FILE) {
  const users = new Map();
  if (filename) {
    const accounts = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!Array.isArray(accounts) || !accounts.some((account) => account.role === 'admin')) {
      throw new Error('The users file must contain an array with at least one admin.');
    }
    for (const account of accounts) {
      const [algorithm, salt = '', hash = ''] = String(account.passwordHash).split('$');
      if (typeof account.username !== 'string' || !account.username || /[:\s]/.test(account.username) ||
          users.has(account.username) || !['admin', 'capture', 'reader'].includes(account.role) ||
          algorithm !== 'scrypt' || !/^[0-9a-f]{32,128}$/i.test(salt) || !/^[0-9a-f]{128}$/i.test(hash)) {
        throw new Error('Invalid account in the TimeCapsule users file.');
      }
      if (account.collections !== undefined && (!Array.isArray(account.collections) ||
        !account.collections.every((collection) => typeof collection === 'string' && collection.trim()))) {
        throw new Error('Account collections must be an array of non-empty names.');
      }
      users.set(account.username, { role: account.role, collections: account.collections || [], salt, hash });
    }
  }

  // Cache only already-verified credentials. The users file is read once at startup.
  const verified = new Map();

  async function authenticate(req, res, next) {
    if (!filename) {
      req.account = { role: 'admin', username: null };
      return next();
    }
    res.set('Cache-Control', 'private, no-store');
    const header = req.get('Authorization') || '';
    const encoded = /^Basic ([A-Za-z0-9+/=]+)$/i.exec(header)?.[1];
    if (encoded && encoded.length < 1024) {
      const fingerprint = createHash('sha256').update(encoded).digest('hex');
      const saved = verified.get(fingerprint);
      if (saved) { req.account = saved; return next(); }
      const credential = Buffer.from(encoded, 'base64').toString('utf8');
      const separator = credential.indexOf(':');
      const username = credential.slice(0, separator);
      const user = separator > 0 ? users.get(username) : null;
      if (user) {
        try {
          const key = await deriveKey(credential.slice(separator + 1), Buffer.from(user.salt, 'hex'), 64);
          if (timingSafeEqual(key, Buffer.from(user.hash, 'hex'))) {
            req.account = { username, role: user.role, collections: user.collections };
            if (verified.size >= 128) verified.clear();
            verified.set(fingerprint, req.account);
            return next();
          }
        } catch (err) { return next(err); }
      }
    }
    res.set('WWW-Authenticate', 'Basic realm="TimeCapsule", charset="UTF-8"');
    return res.status(401).json({ error: 'Sign in to TimeCapsule.' });
  }

  async function allowedRoots(req) {
    if (req.account.role !== 'reader') return null;
    req.allowedArchiveRoots ||= listTimeline(archiveDir).then((entries) => new Set(entries
      .filter((entry) => entry.collection && req.account.collections.includes(entry.collection))
      .map((entry) => entry.dir)));
    return req.allowedArchiveRoots;
  }

  async function canRead(req, dir) {
    const parts = typeof dir === 'string' ? dir.split('/') : [];
    if (parts.length < 2 || parts.some((segment) => !segment || segment === '.' || segment === '..' || /[\\:\0]/.test(segment))) {
      return false;
    }
    if (req.account.role !== 'reader') return true;
    const root = parts.slice(0, 2).join('/');
    if (req.allowedArchiveRoots) return (await req.allowedArchiveRoots).has(root);
    const state = await fs.promises.readFile(path.join(archiveDir, root, 'organization.json'), 'utf8')
      .then(JSON.parse).catch(() => null);
    return Boolean(state?.collection && req.account.collections.includes(state.collection));
  }

  async function archiveFiles(req, res, next) {
    try {
      const dir = decodeURIComponent(req.path).slice(1);
      if (!await canRead(req, dir)) return res.sendStatus(404);
      if (req.account.role !== 'admin' && /(?:^|\/)page\.warc\.gz$/i.test(dir)) return res.sendStatus(404);
      const root = await fs.promises.realpath(archiveDir).catch(() => null);
      const actual = await fs.promises.realpath(path.join(archiveDir, dir)).catch(() => null);
      if (!root || actual !== path.join(root, dir)) return res.sendStatus(404);
      return next();
    } catch (err) { return next(err); }
  }

  function restrict(...roles) {
    return (req, res, next) => roles.includes(req.account.role)
      ? next() : res.status(403).json({ error: 'Your account cannot perform this action.' });
  }

  return { authenticate, archiveFiles, canRead, allowedRoots, restrict, enabled: Boolean(filename) };
}

module.exports = { createAccess };
