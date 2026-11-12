// Stands in for chrome-devtools-mcp in tests/test_macos.py: its path contains
// "chrome-devtools-mcp", it connects to the port given and asks for a WebSocket
// upgrade the way the real one asks the Tether broker. Prints its own local port.
import net from 'node:net';

const port = Number(process.argv[2]);
const s = net.connect(port, '127.0.0.1', () => {
  process.stdout.write(`${s.localPort}\n`);
  s.write(`GET /devtools/browser/tether HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
    + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
});
s.on('error', () => {});
setTimeout(() => {}, 60000);
