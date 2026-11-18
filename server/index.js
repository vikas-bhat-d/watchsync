const { createSignalingServer } = require('./signaling');

const port = Number(process.env.PORT ?? process.env.SYNCWATCH_SERVER_PORT ?? 3000);
const host = process.env.SYNCWATCH_BIND_HOST ?? '0.0.0.0';
const server = createSignalingServer({ host, port });

server.listen().then((address) => {
  console.log(`SyncWatch signaling server listening on ${address.address}:${address.port}`);
}).catch((error) => {
  console.error('Could not start the SyncWatch signaling server:', error.message);
  process.exitCode = 1;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close().then(() => process.exit(0));
  });
}