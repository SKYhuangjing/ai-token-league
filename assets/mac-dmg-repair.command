#!/bin/bash
set -euo pipefail

APP_NAME="AI Token League.app"
APP_PATH="/Applications/$APP_NAME"

printf '\e[8;26;82t'
clear

echo "AI Token League macOS 启动修复 / Launch Repair"
echo
echo "此工具只会移除以下应用的 macOS quarantine 隔离属性："
echo "This tool only removes the macOS quarantine attribute from:"
echo "  $APP_PATH"
echo
echo "请先把 AI Token League 拖入 Applications；仅当 macOS 提示"
echo "\"已损坏\"、\"无法打开\" 或 \"来自身份不明的开发者\" 时再运行。"
echo

if [[ ! -d "$APP_PATH" ]]; then
  echo "未在 Applications 中找到 AI Token League。"
  echo "请先把 $APP_NAME 拖入 Applications，然后重新运行本工具。"
  echo
  read -r -p "按 Return 关闭窗口 / Press Return to close."
  exit 1
fi

clear_quarantine() {
  local target="$1"
  /usr/bin/xattr -d com.apple.quarantine "$target" 2>/dev/null || true
  /usr/bin/find "$target" -exec /usr/bin/xattr -d com.apple.quarantine {} + 2>/dev/null || true
}

has_quarantine() {
  local target="$1"
  /usr/bin/xattr -p com.apple.quarantine "$target" >/dev/null 2>&1 && return 0
  ! /usr/bin/find "$target" -exec /bin/sh -c '
    for path do
      /usr/bin/xattr -p com.apple.quarantine "$path" >/dev/null 2>&1 && exit 1
    done
    exit 0
  ' sh {} +
}

echo "正在移除 quarantine 隔离属性..."
clear_quarantine "$APP_PATH"
if has_quarantine "$APP_PATH"; then
  echo "需要管理员权限才能修复，请按提示输入开机密码。"
  /usr/bin/sudo /usr/bin/find "$APP_PATH" -exec /usr/bin/xattr -d com.apple.quarantine {} + 2>/dev/null || true
fi
echo "修复完成。现在可以从 Applications 打开 AI Token League。"

echo
read -r -p "按 Return 关闭窗口 / Press Return to close."
