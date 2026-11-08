const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

const stateFile = '.data/windows/dependencies.json'
const manifestKeys = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function tryReadJson(file) {
  try {
    return readJson(file)
  } catch {
    return null
  }
}

function readProject() {
  const manifest = readJson('package.json')
  const raw = fs.readFileSync('package-lock.json')
  const lock = JSON.parse(raw)
  const root = lock.packages?.['']
  if (!root || lock.lockfileVersion < 2) throw new Error('package-lock.json 缺少 npm 锁定信息。')

  for (const key of manifestKeys) {
    const declared = manifest[key] ?? {}
    const locked = root[key] ?? {}
    if (Object.keys(declared).length !== Object.keys(locked).length ||
        Object.entries(declared).some(([name, spec]) => locked[name] !== spec)) {
      throw new Error('package.json 与 package-lock.json 的依赖声明不一致，请获取同步后的两个文件。')
    }
  }

  const packages = Object.entries(lock.packages).filter(([name, entry]) =>
    name && supports(entry.os, process.platform) && supports(entry.cpu, process.arch))
  const fingerprint = {
    lock: createHash('sha256').update(raw).digest('hex'),
    node: process.version,
    platform: process.platform,
    arch: process.arch
  }
  return { packages, fingerprint }
}

function supports(values, current) {
  if (!values) return true
  if (values.includes('!' + current)) return false
  return values.every((value) => value.startsWith('!')) || values.includes(current)
}

function verifyInstalled(packages) {
  const installed = tryReadJson('node_modules/.package-lock.json')?.packages
  if (!installed) throw new Error('缺少 node_modules 或 npm 安装记录。')
  for (const [name, entry] of packages) {
    const actual = installed[name]
    if (!actual || actual.version !== entry.version || actual.integrity !== entry.integrity ||
        actual.resolved !== entry.resolved || tryReadJson(path.join(name, 'package.json'))?.version !== entry.version) {
      throw new Error(`依赖缺失或版本不匹配：${name}（需要 ${entry.version}）。`)
    }
  }
  fs.accessSync('node_modules/.bin/vite.cmd', fs.constants.R_OK)
  fs.accessSync('node_modules/vite/bin/vite.js', fs.constants.R_OK)
  require(path.resolve('node_modules/rollup'))
  require(path.resolve('node_modules/esbuild')).transformSync('const ready: boolean = true', { loader: 'ts' })
}

function record(fingerprint) {
  const temporary = `${stateFile}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(fingerprint, null, 2) + '\n')
  fs.renameSync(temporary, stateFile)
}

function run(mode) {
  const { packages, fingerprint } = readProject()
  const previous = tryReadJson(stateFile)
  if (mode !== 'record') {
    const changed = previous && Object.keys(fingerprint).some((key) => previous[key] !== fingerprint[key])
    if (changed || (mode === 'check' && !previous)) {
      console.log(changed ? '依赖锁或 Node.js 环境已变化。' : '未找到依赖初始化记录。')
      return 3
    }
  }

  try {
    verifyInstalled(packages)
  } catch (error) {
    if (mode === 'record') throw error
    console.log(`依赖检查未通过。${error.message}`)
    return 3
  }

  if (mode === 'record' || (mode === 'prepare' && !previous)) record(fingerprint)
  return 0
}

try {
  process.exitCode = run(process.argv[2])
} catch (error) {
  console.error(`[依赖] ${error.message}`)
  process.exitCode = 1
}
