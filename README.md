# 證件排版輸出工具 (ID Document Layout Tool)

上傳台灣身分證正反面、護照內頁照片，手動點選四角完成透視校正，並排版輸出為 A4 尺寸 PDF。

## 功能
- 手動點選四角＋自動透視校正（去除拍攝角度造成的變形）
- 90° 旋轉（修正橫拍/歪斜照片）
- 亮度／對比（曝光）調整，即時預覽
- 灰階切換
- 輸出 A4 (21×29.7cm) PDF：
  - 身分證正反面：8×4.8cm
  - 護照內頁：12.5×8.8cm

## 檔案
- `id-doc-layout-tool.html`：獨立單檔網頁版，用瀏覽器直接開啟即可使用，不需要伺服器
- `id-doc-layout-tool.jsx`：React 版本，適合作為 Claude Artifact 或整合進既有 React 專案

## 使用方式（HTML 版）
直接下載 `id-doc-layout-tool.html`，用瀏覽器（Chrome / Safari 等）開啟即可。

## 注意事項
- iPhone 拍攝的 HEIC 格式照片多數瀏覽器無法讀取，請改用 JPG/PNG，或於 iPhone「設定 → 相機 → 格式」改為「最相容」
- 建議在桌面瀏覽器操作可獲得較大的預覽畫面
