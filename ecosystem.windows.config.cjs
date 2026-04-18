// Windows-adapted ecosystem for horizon.
// Differences from ecosystem.config.cjs:
//   - interpreter: Windows bun path
//   - script: src/core/server.ts (upstream's src/server.ts doesn't exist)
//   - maw-boot: DISABLED (tmux fleet resume — Linux-only)
//   - maw-broker: DISABLED (src/broker.ts missing in upstream — would crash-loop)
module.exports = {
  apps: [
    {
      name: 'maw',
      script: 'src/core/server.ts',
      interpreter: 'C:\\Users\\Lenovo\\.bun\\bin\\bun.exe',
      watch: ['src'],
      watch_delay: 500,
      ignore_watch: ['node_modules', 'ui', 'test'],
      env: {
        MAW_HOST: 'local',
        MAW_PORT: '3456',
        MAW_UI_DIR: 'C:\\Users\\Lenovo\\repos\\Soul-Brews-Studio\\maw-ui\\dist',
      },
    },
  ],
};
