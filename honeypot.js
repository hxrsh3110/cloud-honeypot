const net = require('net');
const fs = require('fs');
const path = require('path');

const PORT = 2222;
const LOG_PATH = path.join(__dirname, 'logs', 'threat-logs.txt');
const CONNECTION_TIMEOUT_MS = 15000;

function sanitize(input) {
  return input.replace(/[\x00-\x1F\x7F]/g, '').slice(0, 100);
}

function logAttempt(ip, username, password, status) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] IP: ${ip} | Username: ${username || '-'} | Password: ${password || '-'} | Status: ${status}\n`;
  console.log(logEntry.trim());
  fs.appendFile(LOG_PATH, logEntry, (err) => {
    if (err) console.log("Failed to save log.");
  });
}

const server = net.createServer((socket) => {
  let attackerIP = socket.remoteAddress;
  if (attackerIP && attackerIP.startsWith('::ffff:')) {
    attackerIP = attackerIP.slice(7);
  }

  let state = 'username';
  let username = '';
  let buffer = '';

  const timeout = setTimeout(() => {
    logAttempt(attackerIP, username, null, 'timeout');
    socket.destroy();
  }, CONNECTION_TIMEOUT_MS);

  socket.write("Ubuntu 24.04 LTS (GNU/Linux)\r\nlogin: ");

  socket.on('data', (data) => {
    buffer += data.toString();
    if (buffer.includes('\n')) {
      const line = sanitize(buffer.split('\n')[0].replace('\r', ''));
      buffer = '';

      if (state === 'username') {
        username = line;
        state = 'password';
        socket.write("Password: ");
      } else if (state === 'password') {
        const password = line;
        clearTimeout(timeout);
        logAttempt(attackerIP, username, password, 'complete');
        socket.write("\r\nLogin incorrect\r\n");
        setTimeout(() => socket.destroy(), 1000);
      }
    }
  });

  socket.on('error', () => clearTimeout(timeout));
  socket.on('close', () => clearTimeout(timeout));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[+] Security Honeypot active. Listening on port ${PORT}...`);
});