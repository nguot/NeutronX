import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 8080,
    // Vite runs inside WSL but the project lives on the Windows filesystem
    // (/mnt/c/...), so chokidar's native fs events don't fire for edits made
    // from the Windows side. Poll instead so HMR/restarts pick up changes.
    watch: { usePolling: true, interval: 300 },
  },
})
