import { spawn } from 'node:child_process'
const children = ['server', 'receiver', 'worker'].map((name) =>
  spawn(process.execPath, [`src/${name}.ts`], { stdio: 'inherit', env: process.env }),
)
let stopping = false
function stop(code: number) {
  if (stopping) return
  stopping = true
  process.exitCode = code
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
  const deadline = setTimeout(() => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL')
  }, 20_000).unref()
  Promise.all(
    children.map((child) =>
      child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : new Promise((resolve) => child.once('exit', resolve)),
    ),
  ).then(() => clearTimeout(deadline))
}
for (const child of children) {
  child.once('error', (error) => {
    console.error(error)
    stop(1)
  })
  child.once('exit', (code) => {
    if (!stopping) stop(code || 1)
  })
}
process.once('SIGINT', () => stop(0))
process.once('SIGTERM', () => stop(0))
