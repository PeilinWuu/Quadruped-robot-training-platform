import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const label = process.argv[2] ?? 'native-viewer'
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

const memory = (pid) => {
  const path = `/proc/${pid}/smaps_rollup`
  if (!existsSync(path)) return null
  const fields = Object.fromEntries(readFileSync(path, 'utf8').split('\n').flatMap((line) => {
    const match = line.match(/^([A-Za-z_]+):\s+(\d+) kB$/)
    return match ? [[match[1], Number(match[2])]] : []
  }))
  const status = readFileSync(`/proc/${pid}/status`, 'utf8')
  const rss = Number(status.match(/^VmRSS:\s+(\d+) kB$/m)?.[1] ?? 0)
  return { rss, pss: fields.Pss ?? 0, privateDirty: fields.Private_Dirty ?? 0, anonymous: fields.Anonymous ?? 0 }
}

const cpuTicks = (pid) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return Number(fields[11]) + Number(fields[12])
  } catch { return null }
}

const gpu = () => {
  try {
    const line = execFileSync('nvidia-smi', [
      '--query-gpu=utilization.gpu,memory.used', '--format=csv,noheader,nounits',
    ], { encoding: 'utf8' }).trim().split('\n')[0]
    const [utilization, memoryUsed] = line.split(',').map((value) => Number(value.trim()))
    return { utilization, memoryUsed }
  } catch { return { utilization: -1, memoryUsed: -1 } }
}

writeFileSync(output, 'elapsed_s\tgroup\tpid\trss_kb\tpss_kb\tprivate_dirty_kb\tanonymous_kb\tcpu_pct\tgpu_util_pct\tgpu_memory_mib\n')
const started = performance.now()
const previousCpu = new Map()
for (const target of schedule) {
  const remaining = target * 1000 - (performance.now() - started)
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining))
  const graphics = gpu()
  for (const process of processes()) {
    const values = memory(process.pid)
    if (!values) continue
    const ticks = cpuTicks(process.pid)
    const previous = previousCpu.get(`${process.group}:${process.pid}`)
    const cpu = previous && ticks != null
      ? ((ticks - previous.ticks) / 100) / Math.max(target - previous.elapsed, 0.001) * 100
      : 0
    if (ticks != null) previousCpu.set(`${process.group}:${process.pid}`, { ticks, elapsed: target })
    appendFileSync(output, [target, process.group, process.pid, values.rss, values.pss,
      values.privateDirty, values.anonymous, cpu.toFixed(2), graphics.utilization,
      graphics.memoryUsed].join('\t') + '\n')
  }
  console.log(`D6_NATIVE_VIEWER_SAMPLE elapsed_s=${target} output=${output}`)
}
console.log(output)
