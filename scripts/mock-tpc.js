import { loadConfig } from '../src/config.js';
import { createMockTpcApp } from '../src/tpc/mock-server.js';

const config = loadConfig();
const port = Number(process.env.MOCK_TPC_PORT) || 4010;
const { app } = createMockTpcApp({ apiKey: config.tpc.apiKey || 'test-key', apiId: config.tpc.apiId || '1' });

app.listen(port, () => {
  console.log(`Mock TPC API on http://localhost:${port}/apps/api/booking`);
  console.log(`Bookings so far: http://localhost:${port}/bookings`);
});
