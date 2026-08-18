const fs = require('fs');
const path = require('path');

const TRAFFIC_LOG_PATH = path.join(__dirname, '..', 'traffic.log');

function timestamp() {
  return new Date().toISOString();
}

// Console output - this is the one place to edit if you want to change what
// the terminal prints while TimeCapsule is running.
function log(message) {
  console.log(`[${timestamp()}] ${message}`);
}

// Appends one line per archive request to traffic.log: <timestamp> <url> <ip>
function logTraffic(url, ip) {
  fs.appendFile(TRAFFIC_LOG_PATH, `${timestamp()} ${url} ${ip}\n`, (err) => {
    if (err) log(`Failed to write traffic.log: ${err.message}`);
  });
}

module.exports = { log, logTraffic };
