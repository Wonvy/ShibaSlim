// Entry point of the engine inside the desktop app. desktop/stage.mjs copies it to
// src-tauri/engine/main.mjs, next to dist/ and gui/, and the app runs it with its
// bundled Node runtime.
//
// It starts the same local server as `shibaslim gui` and talks to the app through
// stdio: one JSON line per message on stdout, and stdin stays open for as long as
// the app wants the engine running.

import { startGui } from './dist/gui.js';

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

let server;
let stopping = false;

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  // An open connection (an upload, the page's event stream) must not hold up quitting.
  const timeout = new Promise((resolve) => setTimeout(resolve, 1500).unref());
  await Promise.race([server?.close(), timeout]).catch(() => {});
  process.exit(code);
}

try {
  server = await startGui({
    desktop: true,
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
process.stdin.on('end', () => void stop());
process.stdin.on('error', () => void stop());
process.stdin.resume();
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
