// The only bridge between the renderer and the model machinery.
//
// The window stays contextIsolated with nodeIntegration off and exposes a small,
// fixed set of calls rather than anything resembling `require`. Generated code
// never sees even these: the canvas runs it in a sandboxed iframe with an
// opaque origin, and preload scripts don't run in subframes.
const { contextBridge, ipcRenderer } = require('electron')

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args)

contextBridge.exposeInMainWorld('jemero', {
  /** User settings, persisted by the main process (see registerStoreIpc). */
  settings: {
    load: () => ipcRenderer.sendSync('settings:load'),
    save: (value) => ipcRenderer.send('settings:save', value),
  },
  /** The component library: every component, version and conversation. */
  library: {
    load: () => ipcRenderer.sendSync('library:load'),
    save: (value) => ipcRenderer.send('library:save', value),
  },
  /** Machine profile: chip, unified memory, GPU cores, bandwidth, model budget. */
  device: () => invoke('models:device'),
  /** Catalog scored for this machine, plus what's installed and what's serving. */
  catalog: (priority) => invoke('models:catalog', priority),
  /** Chat models on Hugging Face beyond the catalog, sized for this machine. */
  search: (query, priority) => invoke('models:search', query, priority),
  install: (modelId) => invoke('models:install', modelId),
  cancelInstall: (modelId) => invoke('models:cancel', modelId),
  remove: (modelId) => invoke('models:remove', modelId),
  /** Restart the local server on a different model. */
  activate: (modelId) => invoke('models:activate', modelId),
  /** Menu-bar commands (⌘L, ⌘,). Returns an unsubscribe function. */
  onMenu: (fn) => {
    const listener = (_event, which) => fn(which)
    ipcRenderer.on('menu:open', listener)
    return () => ipcRenderer.removeListener('menu:open', listener)
  },
  /** Download progress + activation status. Returns an unsubscribe function. */
  onProgress: (fn) => {
    const listener = (_event, payload) => fn(payload)
    ipcRenderer.on('models:progress', listener)
    return () => ipcRenderer.removeListener('models:progress', listener)
  },
})
