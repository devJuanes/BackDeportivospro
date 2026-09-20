module.exports = {
  apps: [
    {
      name: "backdeportivospro",
      cwd: __dirname,
      script: "src/server.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "700M",
      restart_delay: 5000,
      time: true,
      out_file: "./logs/pm2-out.log",
      error_file: "./logs/pm2-error.log",
      merge_logs: true,
      env: {
        NODE_ENV: "production",
        PORT: 3009,
      },
    },
  ],
};
