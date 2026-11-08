const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function loadKey() {
  const envKey = process.env.DEEPSEEK_API_KEY?.trim()
  if (envKey) return envKey
  const file = path.join(os.homedir(), '.dsh', '.credentials.yaml')
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const match = raw.match(/DEEPSEEK_API_KEY[\s\S]{0,200}?(sk-[A-Za-z0-9_-]{10,})/) ||
      raw.match(/(sk-[A-Za-z0-9_-]{20,})/)
    return match?.[1] ?? null
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return null
  }
}

// The Windows launcher checks this via exit status only.
if (require.main === module) {
  try {
    process.exitCode = loadKey() ? 0 : 3
  } catch {
    console.error('无法读取 ~/.dsh/.credentials.yaml，请检查文件权限。')
    process.exitCode = 1
  }
}

module.exports = { loadKey }
