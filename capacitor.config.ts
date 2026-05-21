import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.orchestrel.chat',
  appName: 'Orc Chat',
  webDir: 'build/client',
  server: {
    url: 'https://orchestrel.com/chat/chat',
    cleartext: false,
  },
};

export default config;
