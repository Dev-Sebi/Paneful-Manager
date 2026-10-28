// Prints the login URL: `node dist/login-url.js [--port <n>]`. The key is read from the 0600 state file.
import { resolveLoginUrl } from './security/access-key.js'

resolveLoginUrl(process.env, process.argv.slice(2)).then(
  url => process.stdout.write(`${url}\n`),
  (error: unknown) => {
    process.stderr.write(`${(error as Error).message}\n`)
    process.exit(1)
  },
)
