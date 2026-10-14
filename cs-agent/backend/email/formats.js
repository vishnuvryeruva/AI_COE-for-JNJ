const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { simpleParser } = require('mailparser');

const MAX_EMAIL_BYTES = 32 * 1024 * 1024;
const MSG_SIGNATURE = Buffer.from('d0cf11e0a1b11ae1', 'hex');

function emailFileError(message, status = 400) {
  const error = new Error(message);
  error.status = error.statusCode = status;
  return error;
}

function isMsg(raw) {
  return raw.length >= 8 && raw.subarray(0, 8).equals(MSG_SIGNATURE);
}

/** The binary parser runs outside the HTTP thread, with a hard time/heap limit. */
function readMsg(buffer) {
  if (buffer.length < 512 || buffer.readUInt16LE(28) !== 0xfffe ||
      ![9, 12].includes(buffer.readUInt16LE(30)) || buffer.readUInt16LE(32) !== 6) {
    throw emailFileError('This .msg file is damaged or incomplete. Save the email again from Outlook and retry.');
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'msg-worker.js'), {
      workerData: buffer,
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
    });
    let settled = false;
    const finish = (error, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(error);
      else resolve(data);
    };
    const timer = setTimeout(() => finish(emailFileError(
      'This .msg file could not be read within the time limit. Save it again from Outlook or import it from your connected inbox.'
    )), 5000);
    worker.once('message', ({ data, error }) => finish(error ? emailFileError(error) : null, data));
    worker.once('error', () => finish(emailFileError(
      'This .msg file could not be read. Save the email again from Outlook or import it from your connected inbox.'
    )));
    worker.once('exit', () => {
      if (!settled) finish(emailFileError('The .msg reader stopped before finishing. Save the email again from Outlook and retry.'));
    });
  });
}

async function readEmail(raw, { filename = '' } = {}) {
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (!buffer.length) throw emailFileError('The email file is empty. Choose a saved .msg or .eml email.');
  if (buffer.length > MAX_EMAIL_BYTES) throw emailFileError('Email files must be 32 MB or smaller.', 413);
  if (filename && !/\.(msg|eml)$/i.test(filename)) {
    throw emailFileError('Upload an Outlook .msg or .eml email file.');
  }
  if (isMsg(buffer)) return { ...await readMsg(buffer), format: 'MSG' };
  if (/\.msg$/i.test(filename)) {
    throw emailFileError('This file is not a valid Outlook .msg email. Save the email again from Outlook; changing the file extension does not convert it.');
  }
  // mailparser accepts arbitrary text, so validate the RFC 5322 header block first.
  const header = buffer.subarray(0, 128 * 1024).toString('utf8').split(/\r?\n\r?\n/, 1)[0];
  if (!/^(?:from|to|subject|date|message-id|mime-version):/im.test(header) || header.includes('\0')) {
    throw emailFileError('This file is not a readable .eml email. Save the message as .msg or .eml and retry.');
  }
  try {
    return { ...await simpleParser(buffer), format: 'EML' };
  } catch {
    throw emailFileError('This .eml file could not be read. Save the email again and retry.');
  }
}

module.exports = { readEmail, isMsg, emailFileError, MAX_EMAIL_BYTES };
