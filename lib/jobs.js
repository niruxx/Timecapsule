const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');

// In-memory registry of in-flight/recently-finished archive jobs, so the SSE progress stream
// and the stop endpoint (both separate HTTP requests from the one that kicked the job off) can
// find the same job by id. Finished jobs are kept around briefly so a client that connects to
// the event stream a moment late still gets the final status instead of a 404.
const JOB_TTL_MS = 10 * 60 * 1000;
const jobs = new Map();

function createJob() {
  const id = randomUUID();
  const job = {
    id,
    emitter: new EventEmitter(),
    abortController: new AbortController(),
    status: 'running', // running | awaiting-verification | done | error | stopped
    result: null,
    error: null,
    page: null,
    verifyBrowser: null,
    mainDir: null,
    verificationInfo: null,
  };
  job.emitter.setMaxListeners(0);
  jobs.set(id, job);
  return job;
}

function getJob(id) {
  return jobs.get(id);
}

function finishJob(job) {
  setTimeout(() => jobs.delete(job.id), JOB_TTL_MS).unref();
}

module.exports = { createJob, getJob, finishJob };
