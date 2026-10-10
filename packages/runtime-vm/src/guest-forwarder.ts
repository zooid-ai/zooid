/**
 * Runs in the guest under `node -e`: listens on 127.0.0.1:<port> and pipes
 * each connection to a fresh connection on the mounted host socket. Lets a
 * guest HTTP client that only speaks TCP reach a host service with no route
 * to the host. A second instance on the same port exits 0. [ZOD128]
 */
export const GUEST_FORWARDER_JS = `
const net = require('node:net')
const [port, sock] = process.argv.slice(1)
const server = net.createServer((client) => {
  const upstream = net.connect(sock)
  client.pipe(upstream).pipe(client)
  const done = () => { client.destroy(); upstream.destroy() }
  client.on('error', done); upstream.on('error', done)
  client.on('close', done); upstream.on('close', done)
})
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') process.exit(0)
  console.error(err.message); process.exit(1)
})
server.listen(Number(port), '127.0.0.1')
`

/** `smolvm machine exec -d` keeps the forwarder running after the exec returns. */
export function buildForwarderArgv(machine: string, port: number, socket: string): string[] {
  return ['machine', 'exec', '-d', '--name', machine, '--', 'node', '-e', GUEST_FORWARDER_JS, String(port), socket]
}
