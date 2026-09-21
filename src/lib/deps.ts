// Models routinely import a package and forget to declare it. Rather than waiting
// for the dev server to fail and scraping the error, read the imports straight out
// of the generated code and install anything that isn't there yet.

const IMPORT_RE =
  /(?:import\s+(?:[\s\S]*?\s+from\s+)?|export\s+[\s\S]*?\s+from\s+|require\s*\(\s*|import\s*\(\s*)["']([^"']+)["']/g

/** 'date-fns/locale' -> 'date-fns', '@scope/pkg/sub' -> '@scope/pkg', './x' -> null */
export function packageOf(spec: string): string | null {
  if (!spec || spec.startsWith('.') || spec.startsWith('/')) return null
  if (spec.startsWith('node:') || spec.startsWith('http:') || spec.startsWith('https:')) return null
  const parts = spec.split('/')
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  return /^[@a-z0-9][\w.@/-]*$/i.test(name) ? name : null
}

/** Package names imported by `code` that aren't in `installed`. */
export function missingDeps(files: Record<string, string>, installed: Set<string>): string[] {
  const found = new Set<string>()
  for (const code of Object.values(files)) {
    IMPORT_RE.lastIndex = 0
    for (let m = IMPORT_RE.exec(code); m; m = IMPORT_RE.exec(code)) {
      const pkg = packageOf(m[1])
      if (pkg && !installed.has(pkg)) found.add(pkg)
    }
  }
  return [...found]
}

/** Deps the mounted template already provides — see lib/template.ts. */
export const BASE_DEPS = new Set([
  'react',
  'react-dom',
  'vite',
  '@vitejs/plugin-react',
  '@radix-ui/react-slider',
  '@radix-ui/react-slot',
  '@radix-ui/react-switch',
  '@radix-ui/react-tabs',
  'class-variance-authority',
  'clsx',
  'lucide-react',
  'recharts',
  'tailwind-merge',
  'tailwindcss',
  'tailwindcss-animate',
  'postcss',
  'autoprefixer',
])
