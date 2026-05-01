module.exports = {
  apps: [
    {
      name: "backdeportivospro-api",
      cwd: "/var/www/backdeportivospro",
      script: "src/server.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "400M",
      env: {
        NODE_ENV: "production",
        PORT: 3009,
      },
    },
  ],
};
module.exports = {
  apps: [
    {
      name: "backdeportivospro",
      cwd: __dirname,
      script: "npm",
      args: "start",
      interpreter: "none",
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
      },
    },
  ],
};
