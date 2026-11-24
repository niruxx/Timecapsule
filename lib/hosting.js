const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHash, randomUUID } = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { operationError } = require('./operations');

const exec = promisify(execFile);

async function manifest(root) {
  const entries = [];
  async function visit(dir) {
    const children = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const absolute = path.join(dir, child.name);
      if (child.isDirectory()) { await visit(absolute); continue; }
      if (!child.isFile()) throw operationError('Archive backups require regular files and directories.');
      const hash = createHash('sha256');
      for await (const chunk of fs.createReadStream(absolute)) hash.update(chunk);
      entries.push([path.relative(root, absolute).split(path.sep).join('/'), hash.digest('hex')]);
    }
  }
  await visit(root);
  return entries;
}

function createStorage(archiveDir, env = process.env, execute = exec) {
  const remote = env.TIMECAPSULE_S3_URI?.replace(/\/+$/, '') || '';
  if (remote && !/^s3:\/\/[a-z\d][a-z\d.\-]*(?:\/[^\s]+)?$/i.test(remote)) {
    throw new Error('TIMECAPSULE_S3_URI must be an s3://bucket/prefix URL.');
  }
  const endpoint = env.TIMECAPSULE_S3_ENDPOINT || '';
  if (endpoint && !/^https?:\/\//i.test(endpoint)) throw new Error('TIMECAPSULE_S3_ENDPOINT must be an HTTP or HTTPS endpoint.');
  const replicateEnabled = Boolean(remote && env.TIMECAPSULE_S3_REPLICATE === '1');
  let active = '';
  let pendingReplication = Promise.resolve();

  async function aws(action, from, to, ...flags) {
    if (!remote) throw operationError('Configure TIMECAPSULE_S3_URI to enable S3 backups.');
    const args = ['s3', action, from, to, '--only-show-errors', ...flags];
    if (endpoint) args.push('--endpoint-url', endpoint);
    await execute('aws', args, { timeout: 60 * 60 * 1000, maxBuffer: 1024 * 1024 });
  }

  async function backup() {
    if (active) throw operationError('A storage operation is already running.', 409);
    if (!remote) throw operationError('S3 storage is disabled.');
    active = 'backup';
    let scratch;
    try {
      scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'timecapsule-s3-'));
      const checkpoint = randomUUID();
      const initial = JSON.stringify(await manifest(archiveDir));
      if (initial === '[]') throw operationError('There is nothing to back up.');
      await aws('sync', archiveDir, `${remote}/checkpoints/${checkpoint}/archive/`, '--no-follow-symlinks');
      if (initial !== JSON.stringify(await manifest(archiveDir))) {
        throw operationError('The archive changed during backup. Run the backup when captures and edits are idle.', 409);
      }
      const listing = path.join(scratch, 'manifest.json');
      const latest = path.join(scratch, 'latest.json');
      await fs.promises.writeFile(listing, initial);
      await fs.promises.writeFile(latest, JSON.stringify({ checkpoint }));
      await aws('cp', listing, `${remote}/checkpoints/${checkpoint}/manifest.json`);
      await aws('cp', latest, `${remote}/latest.json`);
      return { checkpoint };
    } finally {
      try { if (scratch) await fs.promises.rm(scratch, { recursive: true, force: true }); }
      finally { active = ''; }
    }
  }

  async function restore() {
    if (active) throw operationError('A storage operation is already running.', 409);
    if (!remote) throw operationError('S3 storage is disabled.');
    active = 'restore';
    let scratch;
    try {
      await fs.promises.mkdir(archiveDir, { recursive: true });
      if ((await fs.promises.readdir(archiveDir)).length) throw operationError('Restore requires an empty archive directory.', 409);
      scratch = await fs.promises.mkdtemp(path.join(path.dirname(archiveDir), '.timecapsule-restore-'));
      const listing = path.join(scratch, 'manifest.json');
      const latest = path.join(scratch, 'latest.json');
      const staged = path.join(scratch, 'archive');
      await fs.promises.mkdir(staged);
      await aws('cp', `${remote}/latest.json`, latest);
      const { checkpoint } = JSON.parse(await fs.promises.readFile(latest, 'utf8'));
      if (typeof checkpoint !== 'string' || !/^[a-f0-9-]{36}$/.test(checkpoint)) throw operationError('Invalid checkpoint identifier.');
      await aws('cp', `${remote}/checkpoints/${checkpoint}/manifest.json`, listing);
      await aws('sync', `${remote}/checkpoints/${checkpoint}/archive/`, staged);
      const expected = JSON.parse(await fs.promises.readFile(listing, 'utf8'));
      if (!Array.isArray(expected) || JSON.stringify(expected) !== JSON.stringify(await manifest(staged))) {
        throw operationError('The downloaded backup failed SHA-256 verification.', 422);
      }
      await fs.promises.rmdir(archiveDir);
      try { await fs.promises.rename(staged, archiveDir); }
      catch (err) { await fs.promises.mkdir(archiveDir, { recursive: true }); throw err; }
      return { checkpoint, files: expected.length };
    } finally {
      try { if (scratch) await fs.promises.rm(scratch, { recursive: true, force: true }); }
      finally { active = ''; }
    }
  }

  function replicate(dir) {
    if (!replicateEnabled) return Promise.resolve();
    if (typeof dir !== 'string' || !/^[^/\\:]+\/[^/\\:]+$/.test(dir) || dir.split('/').some((part) => ['.', '..'].includes(part))) {
      return Promise.reject(operationError('Invalid archive path.'));
    }
    const pending = pendingReplication.then(() => aws('sync', path.join(archiveDir, dir), `${remote}/captures/${dir}/`, '--no-follow-symlinks'));
    pendingReplication = pending.catch(() => {});
    return pending;
  }

  return { enabled: Boolean(remote), replicateEnabled, get restoring() { return active === 'restore'; }, backup, restore, replicate };
}

module.exports = { createStorage };
