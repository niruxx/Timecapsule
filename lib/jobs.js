const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');

const jobs = new Map();
let filename;

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

function jobRecord(job) {
  const { cookies, ...descriptor } = job.descriptor;
  return {
    id: job.id, descriptor, status: job.status, error: job.error, result: job.result,
    createdAt: job.createdAt, updatedAt: job.updatedAt, progress: job.progress, workDir: job.workDir,
  };
}

function saveJobs() {
  if (!filename) return;
  const records = [...jobs.values()];
  const active = records.filter((job) => !isFinished(job));
  const recent = records.filter(isFinished).slice(-200);
  writeJsonAtomic(filename, [...active, ...recent].map(jobRecord));
}

function isFinished(job) {
  return ['done', 'error', 'stopped'].includes(job.status);
}

function register(record) {
  const job = {
    ...record,
    emitter: new EventEmitter(),
    abortController: new AbortController(),
    page: null,
    verifyBrowser: null,
    mainDir: null,
    verificationInfo: null,
  };
  job.emitter.setMaxListeners(0);
  // A job can fail before any SSE client has subscribed.
  job.emitter.on('error', () => {});
  jobs.set(job.id, job);
  return job;
}

function openJobStore(file) {
  filename = file;
  const pending = [];
  const interrupted = [];
  for (const record of readJson(file, [])) {
    const job = register(record);
    if (isFinished(job)) continue;
    if (job.status === 'queued' && !job.descriptor.transient) {
      pending.push(job);
    } else {
      if (job.workDir) interrupted.push(job);
      job.status = 'error';
      job.error = job.descriptor.transient
        ? 'This capture used session cookies. Submit it again with a fresh cookie file.'
        : 'The server restarted during this capture. Retry to start a new capture.';
      job.updatedAt = new Date().toISOString();
    }
  }
  if (jobs.size) saveJobs();
  return { pending, interrupted };
}

function createJob(descriptor) {
  const time = new Date().toISOString();
  const job = register({
    id: randomUUID(), descriptor, status: 'queued', error: null, result: null,
    createdAt: time, updatedAt: time, progress: { type: 'queued' },
  });
  try { saveJobs(); }
  catch (err) { jobs.delete(job.id); throw err; }
  return job;
}

function getJob(id) {
  return jobs.get(id);
}

function updateJob(job, fields) {
  Object.assign(job, fields, { updatedAt: new Date().toISOString() });
  saveJobs();
}

function finishJob() {
  const recent = [...jobs.values()].filter(isFinished);
  for (const previous of recent.slice(0, -200)) jobs.delete(previous.id);
  saveJobs();
}

function listJobs(username, admin) {
  return [...jobs.values()].filter((job) => admin || job.descriptor.owner === username)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function summarizeJob(job) {
  const { id, status, error, createdAt, updatedAt, progress } = job;
  const { target, kind, transient, scheduleId } = job.descriptor;
  return { id, status, error, createdAt, updatedAt, progress, target, kind, scheduleId,
    canRetry: !transient && ['error', 'stopped'].includes(status), archiveDir: job.result?.main?.dir };
}

module.exports = {
  createJob, getJob, finishJob, updateJob, openJobStore, listJobs, summarizeJob, isFinished,
  readJson, writeJsonAtomic,
};
