import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'be.brussels.goutteagoutte',
  appName: 'Goutte à goutte',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
}

export default config