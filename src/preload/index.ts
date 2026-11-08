import { contextBridge, ipcRenderer } from 'electron'
import type { LearningUpdate, LoadResult, SubmitPayload } from '../shared/types'

/** 只暴露这几个动作，渲染进程拿不到 fs / ipc / node */
const api = {
  load: (): Promise<LoadResult & { overview: unknown }> => ipcRenderer.invoke('app:load'),
  submit: (payload: SubmitPayload) => ipcRenderer.invoke('attempt:submit', payload),
  completeTask: (taskId: string) => ipcRenderer.invoke('task:complete', taskId),
  postponeTask: (taskId: string) => ipcRenderer.invoke('task:postpone', taskId),
  rebuildQueue: () => ipcRenderer.invoke('queue:rebuild'),
  learning: (update: LearningUpdate) => ipcRenderer.invoke('learning:update', update),
  check: (questionId: string, answer: string) => ipcRenderer.invoke('answer:check', { questionId, answer }),
  updateSettings: (patch: Record<string, unknown>) => ipcRenderer.invoke('settings:update', patch),
  rate: (nodeId: string, level: 0 | 1 | 2) => ipcRenderer.invoke('node:rate', { nodeId, level })
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
