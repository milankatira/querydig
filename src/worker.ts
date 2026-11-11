import { parentPort } from 'node:worker_threads';
import { analyzeFile } from './fileAnalyzer.js';

parentPort!.on('message', async (msg: { id: number; root: string; file: string }) => {
  const result = await analyzeFile(msg.root, msg.file);
  parentPort!.postMessage({ id: msg.id, result });
});
