import { spawn } from 'node:child_process'
import { loadEnvFile } from 'node:process'

loadEnvFile('.env')
const children = ['server', 'receiver', 'worker'].map((entry) =>
  spawn(process.execPath, [`src/${entry}.ts`], { stdio: 'inherit', env: process.env }),
)
let stopping = false
let deadline: NodeJS.Timeout | undefined
function stop(exitCode: number) {
  if (stopping) return
  stopping = true
  process.exitCode = exitCode
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  deadline = setTimeout(() => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    process.exitCode = 1
  }, 25000)
  deadline.unref()
}
process.once('SIGINT', () => stop(0))
process.once('SIGTERM', () => stop(0))
for (const child of children) {
  child.once('error', (error) => {
    console.error('Could not start process:', error.message)
    stop(1)
  })
  child.once('exit', (code, signal) => {
    if (!stopping) {
      console.error(`A process exited unexpectedly (${code ?? signal}). Stopping the demo.`)
      stop(code || 1)
    }
    if (
      children.every((process) => process.exitCode !== null || process.signalCode !== null) &&
      deadline
    )
      clearTimeout(deadline)
  })
}
