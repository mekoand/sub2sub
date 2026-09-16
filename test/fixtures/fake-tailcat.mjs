#!/usr/bin/env node
import net from 'node:net';
import fs from 'node:fs/promises';
const [mode, address, port] = process.argv.slice(2);
process.stdin.resume();
process.stdin.on('end', () => process.exit());
if (mode === 'serve') {
  if (process.env.SUB2SUB_TEST_TAILCAT_START_DELAY_MS) await new Promise(resolve => setTimeout(resolve, Number(process.env.SUB2SUB_TEST_TAILCAT_START_DELAY_MS)));
  const server = net.createServer(incoming => {
    const outgoing = net.connect(Number(port), '127.0.0.1');
    incoming.pipe(outgoing).pipe(incoming);
    incoming.on('error', () => outgoing.destroy()); outgoing.on('error', () => incoming.destroy());
  });
  let saved; try { saved = JSON.parse(await fs.readFile(address, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  server.listen(saved?.port || 0, '127.0.0.1', async () => { await fs.writeFile(address, JSON.stringify({ port: server.address().port })); process.stdout.write(JSON.stringify({ protocol: 1, address: `test-tailcat:${server.address().port}` }) + '\n'); });
} else {
  const remote = Number(address.split(':')[1]);
  const server = net.createServer(incoming => {
    server.close();
    const outgoing = net.connect(remote, '127.0.0.1');
    incoming.pipe(outgoing).pipe(incoming);
    incoming.on('error', () => outgoing.destroy()); outgoing.on('error', () => incoming.destroy());
  });
  server.listen(0, '127.0.0.1', () => process.stdout.write(JSON.stringify({ protocol: 1, port: server.address().port }) + '\n'));
}
