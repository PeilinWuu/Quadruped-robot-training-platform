const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('d6ChromiumPoc', Object.freeze({
  versions: () => ipcRenderer.invoke('d6-poc:versions'),
}))
