import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const label = process.argv[2] ?? 'native-viewer-light'
const output = process.argv[3] ?? `/tmp/d6-native-viewer-${label}-${Date.now()}.tsv`
const schedule = [0, 30, 60, 120, 180, 300, 420, 600]

const processes = () => {
  const text = execFileSync('ps', ['-eo', 'pid=,comm=,args='], { encoding: 'utf8' })
  return text.trim().split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/)
    if (!match) return []
    const [, pid, command, args] = match
    const group = args.includes('quadruped-simulation-sidecar') ? 'sidecar'
      : args.includes('quadruped-robot-research') ? 'tauri'
        : command.startsWith('WebKitWebProces') ? 'webkit'
          : command.startsWith('WebKitNetworkPr') ? 'webkit-network'
            : null
    return group ? [{ pid: Number(pid), group }] : []
  })
}

// Deliberately use status instead of smaps_rollup. Walking a real-time process's
// complete page tables can perturb its control deadline during locomotion.
const rss = (pid) => {
  const path = `/proc/${pid}/status`
  if (!existsSync(path)) return null
  const status = readFileSync(path, 'utf8')
  return Number(status.match(/^VmRSS:\s+(\d+) kB$/m)?.[1] ?? 0)
}

const cpuTicks = (pid) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return Number(fields[11]) + Number(fields[12])
  } catch { return null }
}

writeFileSync(output, 'elapsed_s\tgroup\tpid\trss_kb\tcpu_pct\n')
const started = performance.now()
const previousCpu = new Map()
for (const target of schedule) {
  const remaining = target * 1000 - (performance.now() - started)
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining))
  for (const process of processes()) {
    const resident = rss(process.pid)
    if (resident == null) continue
    const ticks = cpuTicks(process.pid)
    const key = `${process.group}:${process.pid}`
    const previous = previousCpu.get(key)
    const cpu = previous && ticks != null
      ? ((ticks - previous.ticks) / 100) / Math.max(target - previous.elapsed, 0.001) * 100
      : 0
    if (ticks != null) previousCpu.set(key, { ticks, elapsed: target })
    appendFileSync(output, [target, process.group, process.pid, resident, cpu.toFixed(2)].join('\t') + '\n')
  }
  console.log(`D6_NATIVE_VIEWER_LIGHT_SAMPLE elapsed_s=${target} output=${output}`)
}
console.log(output)
