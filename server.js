import {createApp} from './lib/app.js';
const {server, close} = createApp();
server.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log(`DuetSync listening on port ${server.address().port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await close(); process.exit(0); });
