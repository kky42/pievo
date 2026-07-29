import { defineConfig, loadEnv } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { nitro } from 'nitro/vite'
import viteReact from '@vitejs/plugin-react'
import { developmentProcessEnvironment } from '../../scripts/dev-profile.mjs'

export default defineConfig(({ command, mode }) => {
  if (command === 'serve') {
    const configured = developmentProcessEnvironment(loadEnv(mode, process.cwd(), ''), { ...process.env })
    Object.assign(process.env, configured)
  }

  return {
    // Bind IPv4 127.0.0.1 (not the default IPv6 `localhost`) so the daemon + curl
    // reach the dev server at 127.0.0.1 consistently.
    server: { host: '127.0.0.1', port: Number(process.env.PIEVO_PORT) || 3001, strictPort: true },
    plugins: [
      tailwindcss(),
      tanstackStart(),
      nitro(),
      // react's vite plugin must come after start's vite plugin
      viteReact(),
    ],
  }
})
