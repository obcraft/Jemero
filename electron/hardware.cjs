// What this Mac can actually run.
//
// Local-LLM speed on Apple Silicon is a memory-bandwidth problem, not a FLOPs
// problem: decoding one token reads every active weight once, so
// tokens/sec ≈ usable bandwidth ÷ bytes-read-per-token. That single fact drives
// every recommendation in catalog.cjs, so this module's job is to produce an
// honest bandwidth number and an honest memory budget.
const { execFileSync } = require('node:child_process')
const os = require('node:os')

const GB = 1024 ** 3

function sysctl(key) {
  try {
    return execFileSync('/usr/sbin/sysctl', ['-n', key], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

/** GPU core count, straight from IORegistry, much cheaper than system_profiler. */
function gpuCores() {
  try {
    const out = execFileSync('/usr/sbin/ioreg', ['-rl', '-c', 'AGXAccelerator'], {
      encoding: 'utf8',
      maxBuffer: 8 << 20,
    })
    const m = out.match(/"gpu-core-count"\s*=\s*(\d+)/)
    return m ? Number(m[1]) : 0
  } catch {
    return 0
  }
}

/**
 * Unified-memory bandwidth in GB/s, per chip. These are the published figures;
 * the binned Max parts really do ship slower memory, so they're split out by
 * GPU core count rather than averaged into a wrong single number.
 */
function bandwidthFor(family, variant, cores) {
  const table = {
    M1: { base: 68, Pro: 200, Max: 400, Ultra: 800 },
    M2: { base: 100, Pro: 200, Max: 400, Ultra: 800 },
    M3: { base: 100, Pro: 150, Max: cores && cores <= 30 ? 300 : 400, Ultra: 800 },
    M4: { base: 120, Pro: 273, Max: cores && cores <= 32 ? 410 : 546 },
    M5: { base: 153, Pro: 300, Max: 546 },
  }
  const row = table[family]
  if (!row) return 0
  return row[variant] ?? row.base
}

/**
 * Metal refuses to wire more than iogpu.wired_limit_mb for GPU use; when the
 * sysctl reads 0 the driver default applies, which is ~75% of RAM (a little
 * more on the big-memory machines). Weights live in that wired pool, so it is a
 * hard ceiling on model size no matter how much free RAM `top` reports.
 */
function wiredLimitBytes(ramBytes) {
  const explicit = Number(sysctl('iogpu.wired_limit_mb'))
  if (explicit > 0) return explicit * 1024 * 1024
  const ramGB = ramBytes / GB
  const share = ramGB >= 64 ? 0.8 : ramGB >= 32 ? 0.77 : 0.75
  return Math.floor(ramBytes * share)
}

let cached = null

/** @returns {ReturnType<typeof probe>} */
function detect() {
  if (!cached) cached = probe()
  return cached
}

function probe() {
  const brand = sysctl('machdep.cpu.brand_string') || 'Unknown CPU'
  const appleSilicon = /^Apple M/.test(brand) || os.arch() === 'arm64'
  const m = brand.match(/^Apple (M\d+)\s*(Pro|Max|Ultra)?/)
  const family = m ? m[1] : null
  const variant = m?.[2] ?? 'base'

  const ramBytes = Number(sysctl('hw.memsize')) || os.totalmem()
  const cores = gpuCores()
  const bandwidth = appleSilicon ? bandwidthFor(family, variant, cores) || 100 : 50

  // Everything that is *not* the model: Chromium (the app and its canvas), Vite
  // in development, and the OS itself. Measured at ~5-6 GB when the app still
  // ran a WebContainer sandbox; the canvas needs far less, but the reserve
  // stays, since under-reserving is what makes a Mac swap mid-generation. It
  // scales a little on bigger machines because macOS caches more.
  const hostReserve = Math.max(6 * GB, Math.round(ramBytes * 0.22))
  const wired = wiredLimitBytes(ramBytes)
  // The wired pool isn't ours alone: WindowServer and Chromium's GPU process
  // draw from it too. Filling it to the last megabyte is how you get Metal's
  // "command buffer failed with status 5" mid-load.
  const gpuHeadroom = 1.5 * GB
  const budgetBytes = Math.max(0, Math.min(wired - gpuHeadroom, ramBytes - hostReserve))

  const hw = execFileSync('/usr/sbin/sysctl', ['-n', 'hw.model'], { encoding: 'utf8' }).trim()

  return {
    chip: appleSilicon ? brand : brand,
    family,
    variant,
    appleSilicon,
    machineId: hw,
    machine: machineName(hw),
    isLaptop: /MacBook/.test(machineName(hw)),
    ramBytes,
    ramGB: Math.round(ramBytes / GB),
    cpuCores: Number(sysctl('hw.ncpu')) || os.cpus().length,
    gpuCores: cores,
    bandwidthGBs: bandwidth,
    // What llama.cpp actually sustains with flash attention on Metal. Calibrated
    // on an M4 Pro: Qwen2.5-Coder-14B Q4_K_M decoded at 24.5 tok/s, which is
    // ~75% of the 273 GB/s peak once you account for the embedding table
    // (only one row of it is read per token).
    effectiveBandwidthGBs: Math.round(bandwidth * 0.75),
    wiredLimitBytes: wired,
    hostReserveBytes: hostReserve,
    budgetBytes,
    budgetGB: Math.round((budgetBytes / GB) * 10) / 10,
  }
}

/**
 * Mac16,11 → "Mac mini". Marketing names aren't in sysctl. The older identifiers
 * carry the product in the prefix; the modern "Mac<n>,<n>" ones don't, so those
 * fall through to the profiler.
 */
function machineName(id) {
  const prefix = String(id).replace(/[\d,]+$/, '')
  return (
    {
      MacBookPro: 'MacBook Pro',
      MacBookAir: 'MacBook Air',
      Macmini: 'Mac mini',
      MacStudio: 'Mac Studio',
      MacPro: 'Mac Pro',
      iMac: 'iMac',
    }[prefix] ?? guessFromProfiler(id)
  )
}

/** Mac14,x / Mac16,x are used for several products; ask the profiler once. */
function guessFromProfiler(id) {
  try {
    const out = execFileSync('/usr/sbin/system_profiler', ['SPHardwareDataType'], {
      encoding: 'utf8',
      timeout: 5000,
    })
    return out.match(/Model Name:\s*(.+)/)?.[1]?.trim() ?? id
  } catch {
    return id
  }
}

/** "Mac mini · Apple M4 Pro · 24 GB · 20-core GPU" */
function describe(d = detect()) {
  const bits = [d.machine, d.chip, `${d.ramGB} GB unified`]
  if (d.gpuCores) bits.push(`${d.gpuCores}-core GPU`)
  if (d.bandwidthGBs) bits.push(`${d.bandwidthGBs} GB/s`)
  return bits.join(' · ')
}

module.exports = { detect, describe, GB }
