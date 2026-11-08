import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { Service } from './service'
import type { LearningUpdate, SubmitPayload } from '../shared/types'

let win: BrowserWindow | null = null
let service: Service | null = null

function svc(): Service {
  if (!service) service = new Service()
  return service
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    backgroundColor: '#fbfbfa',
    title: 'KnowMap',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.once('ready-to-show', () => win?.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) win.loadURL(devUrl)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  // GAPGRAPH_DEBUG=1 时开放 CDP，便于用 REA 之类工具检查渲染层
  if (process.env['GAPGRAPH_DEBUG']) {
    app.commandLine.appendSwitch('remote-debugging-port', '9222')
  }
  // 开发期把数据放在项目内 .data，方便查看与清空；打包后走系统 userData
  if (!app.isPackaged) app.setPath('userData', join(app.getAppPath(), '.data'))

  ipcMain.handle('app:load', () => {
    const s = svc()
    return { ...s.load(), overview: s.overview() }
  })

  ipcMain.handle('attempt:submit', (_e, payload: SubmitPayload) => {
    const s = svc()
    const result = s.submit(payload)
    return { ...result, today: s.today(), overview: s.overview() }
  })

  ipcMain.handle('task:complete', (_e, taskId: string) => {
    const s = svc()
    return { ...s.completeTask(taskId), overview: s.overview() }
  })

  ipcMain.handle('task:postpone', (_e, taskId: string) => {
    const s = svc()
    return { ...s.postponeTask(taskId), overview: s.overview() }
  })

  ipcMain.handle('queue:rebuild', () => {
    const s = svc()
    s.rebuild()
    return { ...s.load(), overview: s.overview() }
  })

  ipcMain.handle('learning:update', (_e, update: LearningUpdate) => svc().learning(update))

  ipcMain.handle('answer:check', (_e, args: { questionId: string; answer: string }) => {
    return svc().check(args.questionId, args.answer)
  })

  ipcMain.handle('settings:update', (_e, patch: Record<string, unknown>) => {
    return svc().updateSettings(patch)
  })

  ipcMain.handle('node:rate', (_e, args: { nodeId: string; level: 0 | 1 | 2 }) => {
    const s = svc()
    const state = s.rate(args.nodeId, args.level)
    return { state, today: s.today(), overview: s.overview() }
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
