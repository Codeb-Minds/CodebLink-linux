const { createServer } = require('http');
const { Server } = require('socket.io');
const os = require('os');

const server = createServer();
const io = new Server(server, { cors: { origin: '*' } });

io.on('connection', (socket) => {
  console.log('✅ Device connected:', socket.id);
  socket.on('disconnect', () => console.log('❌ Device disconnected'));
  socket.on('clipboard-update', (data) => console.log('📋 Clipboard received:', data));
});

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of (interfaces[name] || [])) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

server.listen(4321, '0.0.0.0', () => {
  console.log(`✅ Socket.io server running on http://${getLocalIp()}:4321`);
  console.log('   Android app can connect to this address');
});

server.on('error', (err) => console.error('❌ Server error:', err));

setTimeout(() => { console.log('Test complete.'); process.exit(0); }, 3000);
