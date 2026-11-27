// Entry point of the engine inside the desktop app. desktop/stage.mjs copies it to
// src-tauri/engine/main.mjs, next to dist/ and gui/, and the app runs it with its
// bundled Node runtime.
//
// It starts the same local server as `shibaslim gui` and talks to the app over stdio:
// - stdout: one JSON line per message to the app (see EngineMessage in src-tauri/src/engine.rs);
// - stdin: one JSON line per reply to a request, and the end of stdin means the app is gone.
//
// Things the app does better natively (showing a file in its folder, opening a folder, asking
// for a folder or files, opening the comparison window) are requests: { type: 'request', id, call }.

import { createInterface } from 'node:readline';
import { startGui } from './dist/gui.js';

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const pending = new Map();
let lastId = 0;

/** Asks the app to do something; resolves with its result or rejects with its error. */
function request(call) {
  return new Promise((resolve, reject) => {
    const id = ++lastId;
    pending.set(id, { resolve, reject });
    send({ type: 'request', id, call });
  });
}

let server;
let stopping = false;

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const { reject } of pending.values()) reject(new Error('ShibaSlim is closing'));
  // An open connection (an upload, the page's event stream) must not hold up quitting.
  const timeout = new Promise((resolve) => setTimeout(resolve, 1500).unref());
  await Promise.race([server?.close(), timeout]).catch(() => {});
  process.exit(code);
}

try {
  server = await startGui({
    desktop: true,
    appVersion: process.env.SHIBASLIM_APP_VERSION,
    onCheckUpdate: () => send({ type: 'check-update' }),
    shell: {
      reveal: (file) => request({ method: 'reveal', path: file }),
      openFolder: (dir) => request({ method: 'open-folder', path: dir }),
      pickFolder: (prompt) => request({ method: 'pick-folder', title: prompt }),
      pickFiles: (prompt) => request({ method: 'pick-files', title: prompt }),
      openPreview: (url, title) => request({ method: 'open-preview', url, title }),
    },
    // The page's own quit button (hidden in the desktop app, but the endpoint still works).
    onQuit: () => {
      send({ type: 'quit' });
      void stop();
    },
  });
} catch (err) {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
}

send({ type: 'ready', url: server.url });

// The app holds the other end of stdin. When the app exits, even by crashing, stdin ends and so does the engine.
createInterface({ input: process.stdin })
  .on('line', (line) => {
    let reply;
    try {
      reply = JSON.parse(line);
    } catch {
      return;
    }
    const waiting = pending.get(reply.id);
    if (!waiting) return;
    pending.delete(reply.id);
    if (reply.error) waiting.reject(new Error(reply.error));
    else waiting.resolve(reply.result ?? null);
  })
  .on('close', () => void stop());
process.stdin.on('error', () => void stop());
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
