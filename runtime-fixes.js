import childProcess from 'node:child_process';
import stream from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';

// Undici-backed Readable.fromWeb() streams can emit a late `terminated` error
// after their consumer has already handled/canceled the request. Keep a passive
// listener attached so cancellation can never become a process-level crash;
// pipeline()/callers still receive the same error normally.
const originalFromWeb = stream.Readable.fromWeb.bind(stream.Readable);
stream.Readable.fromWeb = function safeFromWeb(...args) {
  const readable = originalFromWeb(...args);
  readable.on('error', () => {});
  return readable;
};

// The bundled FFmpeg build used on some Windows machines rejects the explicit
// stream selector even though the input has a normal video stream. Let FFmpeg
// auto-select its single output video stream instead.
const originalSpawn = childProcess.spawn.bind(childProcess);
childProcess.spawn = function patchedSpawn(command, args, options) {
  if (!Array.isArray(args)) return originalSpawn(command, args, options);
  const fixed = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '-map' && /^0:[vV]:0\??$/.test(String(args[index + 1] || ''))) {
      index++;
      continue;
    }
    fixed.push(args[index]);
  }
  return originalSpawn(command, fixed, options);
};

syncBuiltinESMExports();
