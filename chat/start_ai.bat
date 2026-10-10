@echo off
echo 正在启动 Dify...
wsl -d Ubuntu-22.04 -e bash -c "cd ~/dify/docker && docker compose up -d"

echo 等待 Dify 就绪...
timeout /t 10 /nobreak >nul

echo 正在启动聊天室服务器...
cd /d C:\Users\YI_YOU\Desktop\chat0721-main
node server.js