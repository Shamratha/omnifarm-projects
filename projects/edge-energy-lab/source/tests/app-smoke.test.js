const { test, describe } = require('node:test');
const { vmCases, inspectorVmCases } = require('../scripts/smoke-ui.cjs');

// Existing npm test glob discovers these without dependencies or configuration changes.
// The presentation cases intentionally run through the same DOM stub as the browser
// runner: visible simulation labels, imbalance/Pareto states, and selection-neutral
// export bytes must stay part of the ordinary app smoke suite.
const inspectorNames = new Set(inspectorVmCases.map(([name]) => name));
for (const [name, run] of vmCases) if (!inspectorNames.has(name)) test(name, run);

describe('Window inspector regression smoke (same flows as the browser runner)', () => {
  for (const [name, run] of inspectorVmCases) test(name, run);
});
