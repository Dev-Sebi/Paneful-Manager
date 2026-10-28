// `node dist/login-url.js [--port <n>]` prints a one-time login URL; `--reset` logs every browser out instead.
import { logOutAllDevices, resolveLoginUrl } from './security/access-key.js'

const argv = process.argv.slice(2)

async function run(): Promise<void> {
  if (argv.includes('--reset')) {
    await logOutAllDevices(process.env)
    process.stdout.write('Logged out every browser; their open sessions end with their next request.\n')
    return
  }
  process.stdout.write(`${await resolveLoginUrl(process.env, argv)}\n`)
  process.stderr.write('Open it in the browser to log in; it works once and expires in 10 minutes.\n')
}

run().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`)
  process.exit(1)
})
