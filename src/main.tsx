import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

// Running inside the Electron shell: make the header a drag region and leave
// room for the traffic lights.
if (navigator.userAgent.includes('Electron')) {
  document.documentElement.dataset.shell = 'native'
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
