import { fileURLToPath } from 'node:url';
import { verifyEvidence } from './source/scripts/verify-evidence.js';

const bundleRoot = fileURLToPath(new URL('.', import.meta.url));
const result = await verifyEvidence(bundleRoot);
console.log(JSON.stringify({ ...result, reproduced: true }, null, 2));
