AI Token League - macOS Installation / macOS 安装说明
=====================================================

EN: Drag "AI Token League" to the Applications folder to install.
ZH: 将 "AI Token League" 拖入 Applications 文件夹完成安装。

EN: If macOS says the app "cannot be opened because it is from an unidentified developer"
    or "is damaged and can't be opened", try one of these:

ZH: 如果 macOS 提示"无法打开，因为它来自身份不明的开发者"或"应用已损坏"，请尝试以下方法：

1. Right-click (or Control-click) the app in Finder, select Open, then click Open.
   在 Finder 中右键点击应用，选择"打开"，然后点击"打开"。

2. Or go to System Settings > Privacy & Security and click "Open Anyway".
   或前往 系统设置 > 隐私与安全性，点击"仍要打开"。

3. Or remove the quarantine flag in Terminal:
   或在终端中移除隔离标记：

   sudo xattr -rd com.apple.quarantine "/Applications/AI Token League.app"
