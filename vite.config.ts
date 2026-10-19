import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const page = (name: string) => fileURLToPath(new URL(name, import.meta.url))

export default defineConfig({
  base: '/airi/',
  plugins: [vue()],
  build: {
    // stage.html is the OBS browser source; console.html is the host's
    // control panel. index.html remains the visitor chat demo.
    rolldownOptions: {
      input: { main: page('index.html'), stage: page('stage.html'), console: page('console.html') },
    },
  },
})
