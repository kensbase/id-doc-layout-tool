import { useState, useRef, useEffect, useCallback } from "react";

const PX_PER_CM = 118.11; // ~300dpi
const SLOTS = [
  { key: "front", label: "身分證正面", wCm: 8, hCm: 4.8 },
  { key: "back", label: "身分證背面", wCm: 8, hCm: 4.8 },
  { key: "passport", label: "護照內頁", wCm: 12.5, hCm: 8.8 },
];

/* ---------- 透視變換 ---------- */
function solveLinearSystem(A, B) {
  const n = A.length;
  const M = A.map((row, i) => row.concat([B[i]]));
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const pv = M[col][col] || 1e-12;
    for (let c = col; c <= n; c++) M[col][c] /= pv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}
function getPerspectiveTransform(from, to) {
  const A = [], B = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i], [X, Y] = to[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); B.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); B.push(Y);
  }
  const h = solveLinearSystem(A, B);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}
function warpImage(srcCanvas, quad, outW, outH) {
  const sctx = srcCanvas.getContext("2d");
  const sImg = sctx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
  const sw = srcCanvas.width, sh = srcCanvas.height, sd = sImg.data;
  const out = document.createElement("canvas");
  out.width = outW; out.height = outH;
  const octx = out.getContext("2d");
  const oImg = octx.createImageData(outW, outH);
  const d = oImg.data;
  const H = getPerspectiveTransform([[0, 0], [outW, 0], [outW, outH], [0, outH]], quad);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const w = H[6] * x + H[7] * y + H[8];
      let u = (H[0] * x + H[1] * y + H[2]) / w;
      let v = (H[3] * x + H[4] * y + H[5]) / w;
      u = Math.min(Math.max(u, 0), sw - 1.001);
      v = Math.min(Math.max(v, 0), sh - 1.001);
      const x0 = u | 0, y0 = v | 0, dx = u - x0, dy = v - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      const i = (y * outW + x) * 4;
      for (let c = 0; c < 3; c++) {
        const top = sd[i00 + c] * (1 - dx) + sd[i10 + c] * dx;
        const bot = sd[i01 + c] * (1 - dx) + sd[i11 + c] * dx;
        d[i + c] = top * (1 - dy) + bot * dy;
      }
      d[i + 3] = 255;
    }
  }
  octx.putImageData(oImg, 0, 0);
  return out;
}

function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

// 以像素運算實作亮度/對比/灰階，避免部分瀏覽器環境對 ctx.filter 支援不一致的問題
function applyAdjustPixels(base, adjust) {
  const { brightness, contrast, gray } = adjust;
  const w = base.width, h = base.height;
  const srcCtx = base.getContext("2d");
  const src = srcCtx.getImageData(0, 0, w, h);
  const sd = src.data;

  const out = document.createElement("canvas");
  out.width = w; out.height = h;
  const octx = out.getContext("2d");
  const dst = octx.createImageData(w, h);
  const dd = dst.data;

  const brightAdd = brightness * 1.3; // 滑桿 -100..100 -> 約 -130..130 加減
  const c255 = contrast * 2.55; // 滑桿 -100..100 -> -255..255
  const factor = (259 * (c255 + 255)) / (255 * (259 - c255));

  for (let i = 0; i < sd.length; i += 4) {
    let r = sd[i], g = sd[i + 1], b = sd[i + 2];
    r += brightAdd; g += brightAdd; b += brightAdd;
    r = factor * (r - 128) + 128;
    g = factor * (g - 128) + 128;
    b = factor * (b - 128) + 128;
    if (gray) {
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      r = g = b = l;
    }
    dd[i] = clamp255(r); dd[i + 1] = clamp255(g); dd[i + 2] = clamp255(b); dd[i + 3] = sd[i + 3];
  }
  octx.putImageData(dst, 0, 0);
  return out;
}

/* ---------- 簡易 PDF 產生（無外部函式庫，將A4整頁JPEG包成PDF） ---------- */
function canvasToPdfBlob(canvas) {
  const jpegDataUrl = canvas.toDataURL("image/jpeg", 0.95);
  const b64 = jpegDataUrl.split(",")[1];
  const bin = atob(b64);
  const imgBytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) imgBytes[i] = bin.charCodeAt(i);

  const W = 595.28, Hpt = 841.89; // A4 points
  const enc = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let pos = 0;
  const push = (data) => {
    const bytes = typeof data === "string" ? enc.encode(data) : data;
    chunks.push(bytes); pos += bytes.length;
  };
  push("%PDF-1.4\n");
  const obj = (body) => { offsets.push(pos); push(body); };

  obj(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  obj(`2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`);
  obj(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${Hpt}] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`);
  offsets.push(pos);
  push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imgBytes.length} >>\nstream\n`);
  push(imgBytes);
  push(`\nendstream\nendobj\n`);
  const content = `q ${W} 0 0 ${Hpt} 0 0 cm /Im1 Do Q`;
  obj(`5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);

  const xrefPos = pos;
  let xref = `xref\n0 6\n0000000000 65535 f \n`;
  for (const off of offsets) xref += String(off).padStart(10, "0") + " 00000 n \n";
  push(xref);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`);

  const total = chunks.reduce((s, c) => s + c.length, 0);
  const outBytes = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { outBytes.set(c, o); o += c.length; }
  return new Blob([outBytes], { type: "application/pdf" });
}

/* ---------- 單一證件欄位 ---------- */
function Slot({ cfg, slotState, setSlotState, dispMax }) {
  const canvasRef = useRef(null);
  const activeIdx = useRef(-1);
  const fileRef = useRef(null);
  const s = slotState;

  const drawOverlay = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !s?.natCanvas) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(s.natCanvas, 0, 0, s.dispW, s.dispH);
    const p = s.points;
    ctx.strokeStyle = "#C0392B"; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(p[0].x, p[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(p[i].x, p[i].y);
    ctx.closePath(); ctx.stroke();
    p.forEach((pt) => {
      ctx.beginPath(); ctx.arc(pt.x, pt.y, 10, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(192,57,43,0.25)"; ctx.fill();
      ctx.beginPath(); ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = "#C0392B"; ctx.fill();
    });
  }, [s]);

  useEffect(() => { drawOverlay(); }, [drawOverlay]);

  const initFromCanvas = (natCanvas) => {
    const dispW = Math.min(dispMax, natCanvas.width);
    const dispH = (dispW * natCanvas.height) / natCanvas.width;
    const scale = natCanvas.width / dispW;
    const inset = 0.1;
    const points = [
      { x: dispW * inset, y: dispH * inset },
      { x: dispW * (1 - inset), y: dispH * inset },
      { x: dispW * (1 - inset), y: dispH * (1 - inset) },
      { x: dispW * inset, y: dispH * (1 - inset) },
    ];
    setSlotState({
      natCanvas, dispW, dispH, scale, points,
      corrected: null, final: null,
      adjust: { brightness: 0, contrast: 0, gray: false },
      status: "", statusOk: false, previewUrl: null,
    });
  };

  const onFile = (file) => {
    if (!file) return;
    const nameLower = (file.name || "").toLowerCase();
    if (file.type === "image/heic" || file.type === "image/heif" || nameLower.endsWith(".heic") || nameLower.endsWith(".heif")) {
      setSlotState({ ...(s || {}), status: "HEIC 格式無法讀取，請至 iPhone 設定→相機→格式 改為「最相容」，或改用 JPG/PNG", statusOk: false });
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setSlotState({ ...(s || {}), status: "讀取失敗，請重新選擇照片", statusOk: false });
    reader.onload = (evt) => {
      const img = new Image();
      img.onerror = () => setSlotState({ ...(s || {}), status: "圖片載入失敗，請改用 JPG/PNG 照片", statusOk: false });
      img.onload = () => {
        const MAX_SIDE = 2400;
        let w = img.naturalWidth, h = img.naturalHeight;
        const r = Math.min(1, MAX_SIDE / Math.max(w, h));
        w = Math.round(w * r); h = Math.round(h * r);
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        initFromCanvas(c);
      };
      img.src = evt.target.result;
    };
    reader.readAsDataURL(file);
  };

  const rotate = (dir) => {
    if (!s?.natCanvas) return;
    const src = s.natCanvas;
    const rc = document.createElement("canvas");
    rc.width = src.height; rc.height = src.width;
    const ctx = rc.getContext("2d");
    if (dir === 1) { ctx.translate(rc.width, 0); ctx.rotate(Math.PI / 2); }
    else { ctx.translate(0, rc.height); ctx.rotate(-Math.PI / 2); }
    ctx.drawImage(src, 0, 0);
    initFromCanvas(rc);
  };

  const doCorrect = () => {
    if (!s?.natCanvas) return;
    const quad = s.points.map((p) => [p.x * s.scale, p.y * s.scale]);
    const outW = Math.round(cfg.wCm * PX_PER_CM);
    const outH = Math.round(cfg.hCm * PX_PER_CM);
    setSlotState({ ...s, status: "校正中…", statusOk: false });
    setTimeout(() => {
      try {
        const corrected = warpImage(s.natCanvas, quad, outW, outH);
        const adjust = { brightness: 0, contrast: 0, gray: false };
        const final = applyAdjustPixels(corrected, adjust);
        setSlotState({
          ...s, corrected, final, adjust,
          previewUrl: final.toDataURL("image/jpeg", 0.9),
          status: "✓ 已校正，可調整亮度/對比/灰階", statusOk: true,
        });
      } catch (err) {
        setSlotState({ ...s, status: "校正失敗：" + err.message, statusOk: false });
      }
    }, 30);
  };

  const changeAdjust = (patch) => {
    if (!s?.corrected) return;
    const adjust = { ...s.adjust, ...patch };
    const final = applyAdjustPixels(s.corrected, adjust);
    setSlotState({ ...s, adjust, final, previewUrl: final.toDataURL("image/jpeg", 0.9) });
  };

  const redo = () => setSlotState({ ...s, corrected: null, final: null, previewUrl: null, status: "", statusOk: false });

  /* 拖曳角點 */
  const getPos = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const cx = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    const cy = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
    return { x: (cx * canvas.width) / rect.width, y: (cy * canvas.height) / rect.height };
  };
  const onDown = (e) => {
    if (!s) return;
    const pos = getPos(e);
    let best = -1, bestD = 24;
    s.points.forEach((pt, i) => {
      const d = Math.hypot(pt.x - pos.x, pt.y - pos.y);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best >= 0) { activeIdx.current = best; e.preventDefault(); }
  };
  const onMove = (e) => {
    if (activeIdx.current < 0 || !s) return;
    e.preventDefault();
    const pos = getPos(e);
    const points = s.points.slice();
    points[activeIdx.current] = {
      x: Math.min(Math.max(pos.x, 0), s.dispW),
      y: Math.min(Math.max(pos.y, 0), s.dispH),
    };
    setSlotState({ ...s, points });
  };
  const onUp = () => { activeIdx.current = -1; };

  const btn = { fontFamily: "monospace", fontSize: 12, padding: "8px 14px", border: "1px solid #22314F", background: "#22314F", color: "#fff", cursor: "pointer" };
  const btnSec = { ...btn, background: "#fff", color: "#22314F" };

  return (
    <div style={{ background: "#fff", border: "1px solid #22314F", marginBottom: 22, position: "relative" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "12px 14px 8px", borderBottom: "1px dashed #DAD3C1" }}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>{cfg.label}</div>
        <div style={{ fontFamily: "monospace", fontSize: 11, color: "#C0392B" }}>{cfg.wCm.toFixed(1)} × {cfg.hCm.toFixed(1)} cm</div>
      </div>
      <div style={{ padding: 14 }}>
        <button style={btnSec} onClick={() => fileRef.current && fileRef.current.click()}>選擇照片</button>
        <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }}
          onChange={(e) => { onFile(e.target.files && e.target.files[0]); e.target.value = ""; }} />
        <div style={{ fontSize: 11, color: "#5A6478", marginTop: 6, lineHeight: 1.5 }}>
          上傳後，拖曳四個紅點對齊證件四角，再按「校正」。
        </div>

        {s?.natCanvas && (
          <div style={{ marginTop: 12 }}>
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <button style={btnSec} onClick={() => rotate(-1)}>↺ 左轉90°</button>
              <button style={btnSec} onClick={() => rotate(1)}>↻ 右轉90°</button>
            </div>
            <canvas
              ref={canvasRef}
              width={s.dispW}
              height={s.dispH}
              style={{ width: s.dispW, maxWidth: "100%", display: "block", border: "1px solid #DAD3C1", background: "#eee", touchAction: "none" }}
              onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}
              onTouchStart={onDown} onTouchMove={onMove} onTouchEnd={onUp}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
              <button style={btn} onClick={doCorrect}>校正</button>
              <button style={btnSec} onClick={redo}>重新選取角點</button>
            </div>
          </div>
        )}

        {s?.status && (
          <div style={{ fontFamily: "monospace", fontSize: 11, marginTop: 8, color: s.statusOk ? "#3B7A57" : "#C0392B" }}>{s.status}</div>
        )}

        {s?.previewUrl && (
          <div style={{ marginTop: 12 }}>
            <img src={s.previewUrl} alt="校正結果" style={{ width: s.dispW, maxWidth: "100%", border: "1px solid #22314F" }} />
            <div style={{ marginTop: 12, padding: 12, border: "1px dashed #DAD3C1", background: "#F1EDE3" }}>
              <label style={{ display: "block", fontFamily: "monospace", fontSize: 11, color: "#5A6478", marginBottom: 8 }}>
                亮度 {s.adjust.brightness}
                <input type="range" min={-100} max={100} value={s.adjust.brightness}
                  style={{ width: "100%" }} onChange={(e) => changeAdjust({ brightness: parseInt(e.target.value, 10) })} />
              </label>
              <label style={{ display: "block", fontFamily: "monospace", fontSize: 11, color: "#5A6478", marginBottom: 8 }}>
                對比 / 曝光 {s.adjust.contrast}
                <input type="range" min={-100} max={100} value={s.adjust.contrast}
                  style={{ width: "100%" }} onChange={(e) => changeAdjust({ contrast: parseInt(e.target.value, 10) })} />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: "monospace", fontSize: 11, color: "#5A6478", marginBottom: 10 }}>
                <input type="checkbox" checked={s.adjust.gray} onChange={(e) => changeAdjust({ gray: e.target.checked })} />
                灰階
              </label>
              <button style={btnSec} onClick={() => changeAdjust({ brightness: 0, contrast: 0, gray: false })}>重設調整</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function getDispMax(width) {
  if (width >= 1000) return 640;
  if (width >= 640) return 480;
  return 340;
}

/* ---------- 主元件 ---------- */
export default function App() {
  const [slots, setSlots] = useState({});
  const [pdfMsg, setPdfMsg] = useState(null);
  const [dispMax, setDispMax] = useState(() => getDispMax(typeof window !== "undefined" ? window.innerWidth : 340));

  useEffect(() => {
    const onResize = () => setDispMax(getDispMax(window.innerWidth));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const setSlotState = (key) => (next) => setSlots((prev) => ({ ...prev, [key]: next }));

  const generatePdf = () => {
    const ready = SLOTS.filter((c) => slots[c.key]?.corrected);
    if (ready.length === 0) {
      setPdfMsg({ ok: false, text: "請至少完成一張證件的校正" });
      return;
    }
    try {
      const A4_W = Math.round(21 * PX_PER_CM), A4_H = Math.round(29.7 * PX_PER_CM);
      const page = document.createElement("canvas");
      page.width = A4_W; page.height = A4_H;
      const ctx = page.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, A4_W, A4_H);
      const margin = Math.round(1 * PX_PER_CM), gap = Math.round(0.5 * PX_PER_CM);
      const idW = Math.round(8 * PX_PER_CM), idH = Math.round(4.8 * PX_PER_CM);
      const ppW = Math.round(12.5 * PX_PER_CM), ppH = Math.round(8.8 * PX_PER_CM);
      ctx.font = "28px sans-serif"; ctx.fillStyle = "#888";

      const f = slots.front, b = slots.back, p = slots.passport;
      if (f?.corrected) {
        ctx.drawImage(f.final || f.corrected, margin, margin, idW, idH);
        ctx.fillText("身分證正面", margin, margin + idH + 34);
      }
      if (b?.corrected) {
        const x = margin + idW + gap;
        ctx.drawImage(b.final || b.corrected, x, margin, idW, idH);
        ctx.fillText("身分證背面", x, margin + idH + 34);
      }
      if (p?.corrected) {
        const y = margin + idH + 90, x = Math.round((A4_W - ppW) / 2);
        ctx.drawImage(p.final || p.corrected, x, y, ppW, ppH);
        ctx.fillText("護照內頁", x, y + ppH + 34);
      }

      const blob = canvasToPdfBlob(page);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "證件排版.pdf";
      document.body.appendChild(a); a.click(); a.remove();
      setPdfMsg({ ok: true, text: "✓ PDF 已產生並開始下載", url });
    } catch (err) {
      setPdfMsg({ ok: false, text: "產生失敗：" + err.message });
    }
  };

  return (
    <div style={{
      minHeight: "100vh", color: "#22314F",
      fontFamily: "'Noto Sans TC', sans-serif",
      background: "repeating-linear-gradient(#F1EDE3 0px, #F1EDE3 27px, #DAD3C1 27px, #DAD3C1 28px)",
      paddingBottom: 60,
    }}>
      <header style={{ padding: "28px 20px 18px", borderBottom: "2px solid #22314F" }}>
        <h1 style={{ fontWeight: 700, fontSize: 22, margin: "0 0 4px" }}>證件排版輸出工具</h1>
        <div style={{ fontFamily: "monospace", fontSize: 11, color: "#5A6478" }}>
          ID DOCUMENT LAYOUT · MANUAL CROP + PERSPECTIVE CORRECTION · A4 OUTPUT
        </div>
      </header>
      <main style={{ maxWidth: dispMax + 140, margin: "0 auto", padding: "20px 16px" }}>
        {SLOTS.map((cfg) => (
          <Slot key={cfg.key} cfg={cfg} slotState={slots[cfg.key]} setSlotState={setSlotState(cfg.key)} dispMax={dispMax} />
        ))}
        <div style={{ border: "2px solid #22314F", padding: 16, background: "#fff", textAlign: "center" }}>
          <div style={{ fontFamily: "monospace", fontSize: 11, color: "#C0392B", marginBottom: 10 }}>A4 · 21.0 × 29.7 cm</div>
          <button
            style={{ width: "100%", padding: 14, fontSize: 14, letterSpacing: ".05em", fontFamily: "monospace", border: "1px solid #22314F", background: "#22314F", color: "#fff", cursor: "pointer" }}
            onClick={generatePdf}
          >
            產生 A4 PDF
          </button>
          {pdfMsg && (
            <div style={{ marginTop: 10, fontSize: 12, color: pdfMsg.ok ? "#3B7A57" : "#C0392B" }}>
              {pdfMsg.text}
              {pdfMsg.url && (
                <> — <a href={pdfMsg.url} download="證件排版.pdf" style={{ color: "#C0392B" }}>若未自動下載請點此</a></>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
