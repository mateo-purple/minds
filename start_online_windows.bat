@echo off
chcp 65001 >nul
cd /d %~dp0
if not exist node_modules (
  echo 初回セットアップを開始します...
  call npm install
  if errorlevel 1 (
    echo npm install に失敗しました。Node.js 20以上が入っているか確認してください。
    pause
    exit /b 1
  )
)
start "" http://localhost:3000
npm start
pause
