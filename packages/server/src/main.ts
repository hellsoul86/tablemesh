import { createApplication } from './app.js';

const app = createApplication();
const url = await app.listen();
console.log(`TableMesh API ${url} (local development; real rewards ${app.config.realRewardsEnabled ? 'enabled' : 'disabled'})`);
console.log(`Encrypted inventory ${app.config.inventoryKey ? 'configured' : 'disabled: key missing'}`);
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  if (closing) return;
  closing = true;
  void app.close().then(() => process.exit(0), () => process.exit(1));
});
