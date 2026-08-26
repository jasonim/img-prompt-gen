#!/bin/zsh

cd "${0:A:h}"

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js。请先安装 Node.js 22 或 24 LTS：https://nodejs.org/"
  echo "安装后重新双击此文件。"
  read "?按回车关闭窗口…"
  exit 1
fi

node server/index.js
status=$?
echo ""
echo "服务已停止，退出码：$status"
read "?按回车关闭窗口…"
exit $status
