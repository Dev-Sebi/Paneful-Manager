// Starts the real server for e2e on its own port with private state, config, home and tmux socket.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = process.env.AGENT_HUB_PORT ?? '7340'
const PREFIX = 'agent-hub-e2e-'
const SOCKET = 'agent-hub'
const serverEntry = resolve(dirname(fileURLToPath(import.meta.url)), '../../server/dist/index.js')
const hasTmux = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0

function killTmux (tmuxDir) {
  if (hasTmux) {
    spawnSync('tmux', ['-L', SOCKET, 'kill-server'], { env: { ...process.env, TMUX_TMPDIR: tmuxDir }, stdio: 'ignore' })
  }
}

function isAlive (pidFile) {
  if (!existsSync(pidFile)) {
    return false
  }
  try {
    process.kill(Number(readFileSync(pidFile, 'utf8')), 0)
    return true
  } catch {
    return false
  }
}

// A killed previous run cannot clean up after itself; its daemonized tmux server would linger.
for (const name of readdirSync(tmpdir())) {
  const stale = join(tmpdir(), name)
  if (name.startsWith(PREFIX) && !isAlive(join(stale, 'pid'))) {
    killTmux(join(stale, 'tmux'))
    rmSync(stale, { recursive: true, force: true })
  }
}

const root = mkdtempSync(join(tmpdir(), PREFIX))
const dirs = { home: join(root, 'home'), state: join(root, 'state'), config: join(root, 'config'), tmux: join(root, 'tmux'), claude: join(root, 'claude') }
for (const dir of Object.values(dirs)) {
  mkdirSync(dir, { recursive: true })
}
writeFileSync(join(root, 'pid'), String(process.pid))
// Specs run in other processes; this file tells them where the isolated state lives.
const pathsFile = join(tmpdir(), 'ah-e2e-paths.json')
writeFileSync(pathsFile, JSON.stringify({ state: join(dirs.state, 'agent-hub'), config: join(dirs.config, 'agent-hub') }), { mode: 0o600 })

const env = {
  ...process.env,
  AGENT_HUB_PORT: PORT,
  HOME: dirs.home,
  XDG_STATE_HOME: dirs.state,
  XDG_CONFIG_HOME: dirs.config,
  CLAUDE_CONFIG_DIR: dirs.claude,
  TMUX_TMPDIR: dirs.tmux,
  // Dev mode makes the server honor AGENT_HUB_DEV_ORIGINS, which lists the e2e Vite origin.
  NODE_ENV: 'development',
}
// An inherited $TMUX would point the private server's clients at the caller's tmux.
delete env.TMUX
delete env.TMUX_PANE

if (hasTmux) {
  const started = spawnSync('tmux', ['-f', '/dev/null', '-L', SOCKET, 'start-server', ';', 'set-option', '-g', 'exit-empty', 'off'], { env, stdio: 'inherit' })
  if (started.status !== 0) {
    console.error('[e2e] could not start the private tmux server')
  }
}

const server = spawn(process.execPath, [serverEntry], { env, stdio: 'inherit' })

let cleaned = false
function cleanup () {
  if (cleaned) {
    return
  }
  cleaned = true
  server.kill('SIGTERM')
  killTmux(dirs.tmux)
  rmSync(root, { recursive: true, force: true })
  rmSync(pathsFile, { force: true })
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    cleanup()
    process.exit(0)
  })
}
process.on('exit', cleanup)
server.on('exit', code => {
  cleanup()
  process.exit(code ?? 1)
})
