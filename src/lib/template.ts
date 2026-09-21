// Base project mounted into WebContainer before the model writes anything.
// It ships a full design system (Tailwind + shadcn/ui + lucide + recharts) so the
// model composes with ready-made components instead of reinventing CSS.

import { UI_KIT } from './uikit'

const BASE: Record<string, string> = {
  'package.json': JSON.stringify(
    {
      name: 'generated-app',
      private: true,
      type: 'module',
      scripts: { dev: 'vite --host', build: 'vite build' },
      dependencies: {
        '@radix-ui/react-slider': '^1.2.1',
        '@radix-ui/react-slot': '^1.1.0',
        '@radix-ui/react-switch': '^1.1.1',
        '@radix-ui/react-tabs': '^1.1.1',
        'class-variance-authority': '^0.7.0',
        clsx: '^2.1.1',
        'lucide-react': '^0.454.0',
        react: '^18.3.1',
        'react-dom': '^18.3.1',
        recharts: '^2.13.3',
        'tailwind-merge': '^2.5.4',
      },
      devDependencies: {
        '@vitejs/plugin-react': '^4.3.4',
        autoprefixer: '^10.4.20',
        postcss: '^8.4.49',
        tailwindcss: '^3.4.15',
        'tailwindcss-animate': '^1.0.7',
        vite: '^5.4.11',
      },
    },
    null,
    2,
  ),

  'vite.config.js': `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { host: true, strictPort: true, port: 5173 },
})
`,

  'postcss.config.js': `export default {
  plugins: { tailwindcss: {}, autoprefixer: {} },
}
`,

  'tailwind.config.js': `/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    container: { center: true, padding: '2rem', screens: { '2xl': '1400px' } },
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
        secondary: { DEFAULT: 'hsl(var(--secondary))', foreground: 'hsl(var(--secondary-foreground))' },
        destructive: { DEFAULT: 'hsl(var(--destructive))', foreground: 'hsl(var(--destructive-foreground))' },
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
}
`,

  'index.html': `<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Generated App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`,

  'src/main.jsx': `import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// A render crash leaves a blank page and no dev-server output, so report it to
// the shell instead of failing silently.
const report = (kind, message, stack) => {
  try {
    window.parent.postMessage({ __atomic: true, kind, message: String(message), stack: String(stack || '') }, '*')
  } catch {}
}

window.addEventListener('error', (e) => report('Runtime error', e.message, e.error && e.error.stack))
window.addEventListener('unhandledrejection', (e) => report('Unhandled rejection', e.reason, e.reason && e.reason.stack))

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  componentDidCatch(error) {
    report('Render error', error.message, error.stack)
  }
  render() {
    if (this.state.error) {
      return (
        <div className="grid min-h-screen place-items-center p-8">
          <pre className="max-w-xl whitespace-pre-wrap text-sm text-destructive">{this.state.error.message}</pre>
        </div>
      )
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
`,

  'src/index.css': `@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    /* Themes the native scrollbars and form controls, not just our own colours. */
    color-scheme: light;
    --background: 0 0% 100%;
    --foreground: 240 10% 3.9%;
    --card: 0 0% 100%;
    --card-foreground: 240 10% 3.9%;
    --primary: 252 83% 70%;
    --primary-foreground: 0 0% 100%;
    --secondary: 240 4.8% 95.9%;
    --secondary-foreground: 240 5.9% 10%;
    --muted: 240 4.8% 95.9%;
    --muted-foreground: 240 3.8% 46.1%;
    --accent: 240 4.8% 95.9%;
    --accent-foreground: 240 5.9% 10%;
    --destructive: 0 72% 51%;
    --destructive-foreground: 0 0% 98%;
    --border: 240 5.9% 90%;
    --input: 240 5.9% 90%;
    --ring: 252 83% 70%;
    --radius: 0.75rem;
  }

  .dark {
    color-scheme: dark;
    --background: 229 20% 7%;
    --foreground: 220 14% 91%;
    --card: 228 17% 10%;
    --card-foreground: 220 14% 91%;
    --primary: 252 83% 70%;
    --primary-foreground: 0 0% 100%;
    --secondary: 228 14% 16%;
    --secondary-foreground: 220 14% 91%;
    --muted: 228 14% 16%;
    --muted-foreground: 220 9% 60%;
    --accent: 228 14% 18%;
    --accent-foreground: 220 14% 91%;
    --destructive: 0 62% 51%;
    --destructive-foreground: 0 0% 98%;
    --border: 228 12% 20%;
    --input: 228 12% 20%;
    --ring: 252 83% 70%;
  }

  * { @apply border-border; }
  body { @apply bg-background text-foreground antialiased; }

  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    @apply bg-border;
    border-radius: 6px;
    border: 2px solid transparent;
    background-clip: content-box;
  }
}
`,

  'src/App.jsx': `export default function App() {
  return (
    <main className="grid min-h-screen place-items-center">
      <p className="text-sm text-muted-foreground">Waiting for your first prompt…</p>
    </main>
  )
}
`,
}

export const TEMPLATE: Record<string, string> = { ...BASE, ...UI_KIT }

/** Files the model must not rewrite. */
export const LOCKED_PATHS = [
  'package.json',
  'vite.config.js',
  'postcss.config.js',
  'tailwind.config.js',
  'index.html',
  'src/main.jsx',
  ...Object.keys(UI_KIT),
]

export const TEMPLATE_PATHS = Object.keys(TEMPLATE)
