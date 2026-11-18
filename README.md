# 香港六合彩 Mark Six — 3D 攪珠機模擬器

以 WebGL / Three.js 與 Rapier3D 剛體物理引擎打造的香港六合彩 **3D 攪珠機模擬器**。全程純程式生成模型、號碼球貼圖、全域光照烘培及廣播音效，無需外部 3D 模型或音訊素材即可於瀏覽器流暢運行。

![香港六合彩 Mark Six 3D 攪珠機模擬器實機截圖](./docs/preview.png)

---

## 主要功能

- **擬真 3D 攪珠機結構**：弧形馬蹄 LED 外框光管、無縫白色底座托架、透明亞加力 7×7 入球架與雙側結果分流軌、開放式中央落球圓孔及發光推桿升球機構。
- **Rapier3D 剛體物理攪拌與自然進洞**：49 粒具紅／藍／綠官方色系與 12 面五邊形窗格的號碼球，由底部旋轉亞加力撥臂帶動碰撞翻滾，自然跌入中央圓孔並垂直升上球頂分流至左（6 個正碼）／右（1 個特別號碼）軌道。
- **預烘培靜態全域光照（Baked GI）**：透過 `three-mesh-bvh` 離線計算靜態環境遮蔽（AO）與多彈跳間接照明（Lightmap），兼顧質感與高幀率。
- **多視角與自動導播**：提供 `正面全景`、`機頂俯瞰`、`中央導管特寫`、`左邊軌道`、`右邊軌道` 切換，支援滑鼠自由拖曳／縮放及抽籤過程自動追蹤鏡位。
- **自選號碼對獎與分級中獎特效**：
  - 支援自選 6 個號碼或一鍵「機選一注」，完成攪珠後前 6 個正碼自動由小到大排列，並於選號列與結果列同步亮起命中號碼。
  - **四至七獎**：彩色紙碎慶祝與和弦音效；**二／三獎**：雙側彩炮連發與進階祝捷音效；**頭獎（6 碼全中）**：專屬金色星雨多波彩炮、全畫面金光氛圍光暈、頭獎閃耀橫幅與加長交響鐘聲。
- **快抽模式與開獎紀錄**：可切換標準電視節奏／快速攪珠模式，右側邊欄自動保留最近 10 局開獎紀錄（存於瀏覽器 `localStorage`）。
- **廣播音效與背景音樂**：整合隱藏式 YouTube IFrame 背景音樂播放器（[Shocking Blue - Inkpot](https://www.youtube.com/watch?v=lAwiWIBOz24)），配合 Web Audio 即時合成球體碰撞聲、升球氣動聲及開獎／中獎鐘聲（若瀏覽器封鎖或離線，會自動切換為內置 Web Audio 合成背景音樂，並可隨時一鍵靜音）。

---

## 本地開發

### 環境需求
- Node.js 20+
- npm 10+

### 常用指令

```bash
# 安裝依賴
npm install

# 啟動本地開發伺服器（預設 http://127.0.0.1:5173）
npm run dev

# TypeScript 型別檢查
npm run typecheck

# 建置正式發佈版本（輸出至 dist/）
npm run build

# 預覽正式建置結果
npm run preview

# 如修改機台或燈光靜態幾何，可重新離線烘焙 GI 貼圖至 public/gi/
npm run bake-gi
```

---

## 專案目錄結構

```text
├── .github/workflows/
│   └── deploy-pages.yml          # GitHub Pages 自動建置及部署工作流程
├── docs/
│   └── preview.png               # README 預覽截圖
├── public/gi/                    # 離線烘焙之靜態 AO / Lightmap / UV 配置檔
├── scripts/
│   └── bakeStaticGI.ts           # three-mesh-bvh 全域光照離線烘焙腳本
├── src/
│   ├── audio/                    # Web Audio 即時音效合成引擎
│   ├── balls/                    # 49 粒號碼球貼圖生成、Rapier3D 碰撞與抽籤狀態機
│   ├── camera/                   # 多機位預設與自動導播攝影機控制
│   ├── gi/                       # 靜態光照圖集載入與套用工具
│   ├── machine/                  # 3D 攪珠機台程序化建模
│   ├── studio/                   # 演播室場景與品牌字樣幾何
│   ├── threert/                  # 渲染器、光影與環境反射封裝
│   ├── ui/                       # HUD 介面、對獎邏輯、彩帶特效與歷史紀錄
│   ├── utils/                    # 程序化幾何與貼圖共用工具
│   ├── game.ts                   # 遊戲主迴圈與狀態定義
│   ├── main.ts                   # 應用程式進入點
│   └── style.css                 # 現代玻璃擬態 HUD 樣式
├── index.html                    # 主頁面與 HUD 版面結構
├── package.json
├── tsconfig.json
└── vite.config.ts                # Vite 設定（已啟用 base: "./" 支援子路徑部署）
```

---

## 發佈到 GitHub Pages 步驟

本專案已預先完成 GitHub Pages 相容配置：
- `vite.config.ts` 已設定 `base: "./"`，可直接部署於 `https://<帳號>.github.io/<儲存庫名稱>/` 子路徑。
- `src/main.ts` 已透過 `import.meta.env.BASE_URL` 載入 `public/gi/` 靜態貼圖，確保子路徑下正常讀取。
- 已內建 `.github/workflows/deploy-pages.yml` 自動部署工作流程。

### 公開發佈流程

1. **建立並推送至 GitHub 儲存庫（`main` 分支）**：
   ```bash
   git init
   git add .
   git commit -m "Initial commit: Mark Six 3D simulator"
   git branch -M main
   git remote add origin https://github.com/<你的GitHub用戶名>/<你的Repo名稱>.git
   git push -u origin main
   ```
2. **於 GitHub 開啟 GitHub Pages**：
   - 進入 GitHub 儲存庫頁面 → **Settings** → 左側選單 **Pages**。
   - 在 **Build and deployment** 下的 **Source** 選擇 **GitHub Actions**。
3. **完成自動部署**：
   - 推送至 `main` 後，**Actions** 分頁會自動執行 `Deploy to GitHub Pages`（執行 `npm ci` 與 `npm run build` 並發佈 `dist/`）。
   - 若儲存庫為私人（Private）且帳號非 Pro/Enterprise，請先於 **Settings → General → Danger Zone** 將儲存庫設為 **Public**，方可使用免費公開 GitHub Pages。
   - 部署完成後即可透過頁面顯示的 `https://<你的GitHub用戶名>.github.io/<你的Repo名稱>/` 網址公開瀏覽。

---

## 免責聲明與版權說明（Disclaimer）

> **僅供學術及技術研究用途（For Academic & Educational Research Only）**

- 本專案純屬個人針對 **WebGL / Three.js 3D 渲染、Rapier3D 剛體物理模擬及離線烘焙全域光照（Baked GI）** 之學術與技術研究作品。
- 本專案**並非**香港賽馬會（HKJC）或 Smartplay International 之官方應用程式，與上述機構亦無任何關聯、合作或授權關係；本模擬器完全不涉及任何真實金錢交易、投注功能或商業營利用途。
- 畫面中背景音樂透過 YouTube 官方 IFrame 公開嵌入播放（`lAwiWIBOz24`），所有介面與 3D 機台幾何均以程式碼自行重建作研究示範。
- **如任何權利人或相關單位認為本專案或其中任何內容／音訊嵌入有版權、商標或其他疑慮，歡迎隨時透過 [GitHub Issues](https://github.com/edmondyip/mark-six/issues) 與本人聯繫，本人於接獲通知後將立即配合修改或移除。**

