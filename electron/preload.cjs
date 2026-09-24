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
    /** The items that changed, plus every item id in order (removals and moves). */
    save: (changes) => invoke('library:save', changes),
    /** Files of a generation in progress, saved as they're written. */
    draft: (itemId, files) => ipcRenderer.send('library:draft', itemId, files),
    clearDraft: (itemId) => ipcRenderer.send('library:clear-draft', itemId),
    /** Unfinished drafts, by item: what a crash or quit left behind. */
    drafts: () => invoke('library:drafts'),
  },
  /** Machine profile: chip, unified memory, GPU cores, bandwidth, model budget. */
  device: () => invoke('models:device'),
  /** Whether the quantization switch can help on this Mac, and why not. */
  quantization: () => invoke('models:quantization'),
  /** Prefer 4-bit weights when ranking and choosing models. */
  setQuantization: (on) => invoke('models:set-quantization', on),
  /** Catalog scored for this machine, plus what's installed and what's serving. */
  catalog: (priority) => invoke('models:catalog', priority),
  /** Chat models on Hugging Face beyond the catalog, sized for this machine. */
  search: (query, priority, page) => invoke('models:search', query, priority, page),
  chatBudget: (request) => invoke('models:chat-budget', request),
  install: (modelId) => invoke('models:install', modelId),
  cancelInstall: (modelId) => invoke('models:cancel', modelId),
  remove: (modelId) => invoke('models:remove', modelId),
  /** Restart the local server on a different model. */
  activate: (modelId) => invoke('models:activate', modelId),
  /** Offline readiness: runtime, model and installed packs (electron/main.cjs). */
  offlineCheck: () => invoke('offline:check'),
  /** Packs: the signed catalog, what's installed, and installing with progress. */
  packs: {
    list: () => invoke('packs:list'),
    install: (id) => invoke('packs:install', id),
    cancel: (id) => invoke('packs:cancel', id),
    remove: (id) => invoke('packs:remove', id),
    /** Back to the version active before the last update. */
    rollback: (id) => invoke('packs:rollback', id),
    onProgress: (fn) => {
      const listener = (_event, payload) => fn(payload)
      ipcRenderer.on('packs:progress', listener)
      return () => ipcRenderer.removeListener('packs:progress', listener)
    },
    /** A pack was activated or removed: reload what the canvas can import. */
    onChanged: (fn) => {
      const listener = () => fn()
      ipcRenderer.on('packs:changed', listener)
      return () => ipcRenderer.removeListener('packs:changed', listener)
    },
  },
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
