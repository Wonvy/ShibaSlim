#!/bin/sh
# macOS: double-click to open the ShibaSlim window in your browser.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "需要先安装 Node.js 20 或更高版本：https://nodejs.org"
  printf "按回车键关闭…"; read -r _; exit 1
fi
if [ ! -d node_modules ] || [ ! -f dist/cli.js ]; then
  echo "首次运行，正在安装依赖…"
  npm install || { printf "安装失败，按回车键关闭…"; read -r _; exit 1; }
fi
exec node dist/cli.js gui
