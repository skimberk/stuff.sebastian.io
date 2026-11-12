// Benchmark worker: one variant per Worker (see runner.js).
import { runBench } from './runner.js';

onmessage = ({ data: o }) => runBench(o, (m) => postMessage(m));
