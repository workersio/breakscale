import { pumpJob } from './breakitJob';
import type { FromWorker, ToWorker } from './breakitJob';

/* The search, off the main thread. One job at a time; a new start drops the
   one before it. Long slices, because nothing here has a frame to keep. */

const SLICE_MS = 30;
let current: ReturnType<typeof pumpJob> | null = null;
/* Typed by hand: the app's lib is DOM, where `self` is a window and its
   postMessage wants a target origin. */
const scope = self as unknown as {
  postMessage: (msg: FromWorker) => void;
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
};
const post = (msg: FromWorker) => scope.postMessage(msg);

scope.onmessage = (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'start':
      current?.stop();
      current = pumpJob(
        msg.job,
        SLICE_MS,
        (progress) => post({ type: 'progress', id: msg.id, progress }),
        (result) => post({ type: 'done', id: msg.id, result }),
        (fn) => setTimeout(fn, 0),
      );
      break;
    case 'pause':
      current?.pause();
      break;
    case 'resume':
      current?.resume();
      break;
    case 'stop':
      current?.stop();
      current = null;
      break;
  }
};
