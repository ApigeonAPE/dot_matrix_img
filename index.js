// ==================== 全局状态 & 常量 ====================

let gbMap = null;
let asciiFont = null;
const hzkCache = {};
let fullMatrix = null;
let currentPalette = null;
let zoomLevel = 3;

const ROLE_BG = 0;
const ROLE_BLACK = 1;
const ROLE_TEXT_UL_CN = 2;
const ROLE_TEXT_UL_EN = 3;
const ROLE_TEXT_UR_CN = 4;
const ROLE_TEXT_UR_EN = 5;
const ROLE_TEXT_LO_CN = 6;
const ROLE_TEXT_LO_EN = 7;
const ROLE_OUTLINE = 8;

const FONT_CFG = {
  12: { bpc: 24,  ao: 1  },
  14: { bpc: 28,  ao: 1  },
  24: { bpc: 72,  ao: 16 },
  32: { bpc: 128, ao: 1  },
  40: { bpc: 200, ao: 16 },
};
const FONT_SIZES = [40, 32, 24, 14, 12];
const FONT_F = {
  12: 'hzk12.json',
  14: 'hzk14.json',
  24: 'hzk24_song.json',
  32: 'hzk32.json',
  40: 'hzk40_song.json',
};

// ==================== DOM 快捷 ====================

function $(id) { return document.getElementById(id); }
function S(msg, cls) {
  const el = $('status');
  el.textContent = msg;
  el.className = cls || '';
}

// ==================== 字体加载 ====================

async function loadJSON(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw Error(resp.status);
  return resp.json();
}

async function loadFonts() {
  const [asciiArr, gb] = await Promise.all([
    loadJSON('fonts/ascii_5x7.json'),
    loadJSON('fonts/gb2312_map.json'),
  ]);
  asciiFont = asciiArr;
  gbMap = gb;
}

async function loadHZK(fs) {
  if (hzkCache[fs]) return hzkCache[fs];
  const data = await loadJSON('fonts/' + FONT_F[fs]);
  const bytes = Uint8Array.from(atob(data.base64), c => c.charCodeAt(0));
  hzkCache[fs] = bytes;
  return bytes;
}

async function loadAllHZK() {
  await Promise.all(FONT_SIZES.map(fs => loadHZK(fs).catch(() => null)));
}

// ==================== GB2312 ====================

function gbQW(ch) {
  const cp = ch.codePointAt(0);
  const entry = gbMap[String(cp)];
  return entry ? { qu: entry[0], wei: entry[1] } : null;
}

// ==================== 英文点阵 5×7 ====================

function enDot(text) {
  const n = text.length;
  if (!n) return [[0]];

  const rows = 8;
  const result = Array.from({ length: rows }, () => new Array(n * 5).fill(0));

  for (let i = 0; i < n; i++) {
    const asc = text.charCodeAt(i);
    if (asc < 32 || asc > 127) continue;
    const idx = asc - 32;
    for (let col = 0; col < 5; col++) {
      const byteVal = asciiFont[idx * 5 + col];
      for (let row = 0; row < 7; row++) {
        if ((byteVal >> row) & 1) result[row][i * 5 + col] = 1;
      }
    }
  }
  return result;
}

// ==================== 中文点阵 ====================

function chDot(hzk, ch, fs) {
  const cfg = FONT_CFG[fs];
  if (!cfg) return null;

  const qw = gbQW(ch);
  if (!qw) return null;

  const quOff = qw.qu - cfg.ao;
  if (quOff < 0) return null;

  const offset = (quOff * 94 + (qw.wei - 1)) * cfg.bpc;
  if (offset + cfg.bpc > hzk.length) return null;

  const buf = hzk.slice(offset, offset + cfg.bpc);
  const result = Array.from({ length: fs }, () => new Array(fs).fill(0));

  if (fs === 40 || fs === 12 || fs === 14) {
    // 行转置: bit7 = 左列 (HZK40/HZK12/HZK14)
    const bytesPerRow = cfg.bpc / fs;
    for (let row = 0; row < fs; row++) {
      const rowBase = row * bytesPerRow;
      for (let col = 0; col < fs; col++) {
        const byteIdx = col >>> 3;
        const bitIdx = col & 7;
        if (buf[rowBase + byteIdx] & (1 << (7 - bitIdx))) result[row][col] = 1;
      }
    }
  } else {
    // 列转置: bit7 = 顶行 (HZK24/HZK32)
    const bytesPerCol = cfg.bpc / fs;
    for (let row = 0; row < fs; row++) {
      for (let col = 0; col < fs; col++) {
        const colBase = col * bytesPerCol;
        const byteIdx = row >>> 3;
        const bitIdx = row & 7;
        if (buf[colBase + byteIdx] & (1 << (7 - bitIdx))) result[row][col] = 1;
      }
    }
  }
  return result;
}

function chMat(hzk, text, fs) {
  const n = text.length;
  if (!n) return [[0]];

  const result = Array.from({ length: fs }, () => new Array(n * fs).fill(0));

  for (let i = 0; i < n; i++) {
    const dot = chDot(hzk, text[i], fs);
    if (!dot) continue;
    for (let r = 0; r < fs; r++) {
      for (let c = 0; c < fs; c++) {
        if (dot[r][c]) result[r][i * fs + c] = 1;
      }
    }
  }
  return result;
}

// ==================== 中文自动布局 ====================

function layoutCN(text, zoneW, zoneH, prefer) {
  if (!text) return { layout: [[0]], fs: 0 };

  const startIdx = FONT_SIZES.indexOf(prefer);
  const candidates = FONT_SIZES.slice(startIdx >= 0 ? startIdx : 0);

  for (const fs of candidates) {
    if (!hzkCache[fs]) continue;

    const mat = chMat(hzkCache[fs], text, fs);
    if (!mat || !mat[0].length) continue;

    const n = text.length;
    let cpr = Math.max(1, Math.floor((zoneW + 1) / (fs + 1)));
    if (n <= cpr) cpr = n;

    const rows = Math.ceil(n / cpr);
    const th = rows * fs + (rows - 1) * 2;
    if (th > zoneH) continue;

    const topPad = (rows === 1) ? Math.floor((zoneH - fs) / 2) : 0;
    const mh = (rows === 1) ? zoneH : th;
    const layout = Array.from({ length: mh }, () => new Array(zoneW).fill(0));

    for (let ri = 0; ri < rows; ri++) {
      const sc = ri * cpr;
      const ec = Math.min(sc + cpr, n);
      const rc = ec - sc;

      const tw = rc * fs;
      const gap = rc > 0 ? Math.floor((zoneW - tw) / (rc + 1)) : 0;

      const dstRow = topPad + ri * (fs + 2);
      let curCol = gap;

      for (let ci = 0; ci < rc; ci++) {
        const srcIdx = sc + ci;
        for (let r = 0; r < fs; r++) {
          const nr = dstRow + r;
          if (nr >= mh) break;
          for (let c = 0; c < fs; c++) {
            const nc = curCol + c;
            if (nc >= zoneW) break;
            if (mat[r][srcIdx * fs + c]) layout[nr][nc] = 1;
          }
        }
        curCol += fs + gap;
      }
    }
    return { layout, fs };
  }
  return { layout: [[0]], fs: 0 };
}

// ==================== 矩阵合成 ====================

function blitSp(dst, src, dstRow, dstCol, role, charW, spacing) {
  const srcRows = src.length;
  const srcCols = src[0] ? src[0].length : 0;
  if (!srcCols) return;

  const charCount = Math.floor(srcCols / charW);
  const dstRows = dst.length;
  const dstCols = dst[0].length;

  let destC = dstCol;
  for (let i = 0; i < charCount; i++) {
    for (let sc = 0; sc < charW; sc++) {
      const nc = destC + sc;
      if (nc < 0 || nc >= dstCols) continue;
      for (let sr = 0; sr < srcRows; sr++) {
        const nr = dstRow + sr;
        if (nr < 0 || nr >= dstRows) continue;
        if (src[sr][i * charW + sc]) dst[nr][nc] = role;
      }
    }
    destC += charW;
    if (i < charCount - 1) destC += spacing;
  }
}

function blitL(dst, layout, dstRow, dstCol, role) {
  const lr = layout.length;
  const lc = layout[0] ? layout[0].length : 0;
  const dr = dst.length;
  const dc = dst[0].length;

  for (let r = 0; r < lr; r++) {
    const nr = dstRow + r;
    if (nr < 0 || nr >= dr) continue;
    for (let c = 0; c < lc; c++) {
      const nc = dstCol + c;
      if (nc < 0 || nc >= dc) continue;
      if (layout[r][c]) dst[nr][nc] = role;
    }
  }
}

function addOutline(mat, bg, ol) {
  const rows = mat.length;
  const cols = mat[0].length;
  const orig = mat.map(r => r.slice());
  const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = orig[r][c];
      if (v === bg || v === ROLE_BLACK || v === ol) continue;
      for (const [dr, dc] of dirs) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && orig[nr][nc] === bg) {
          mat[nr][nc] = ol;
        }
      }
    }
  }
}

function composeUpper(chL, enL, chR, enR, bg, cnL, enLr, cnR, enRr, ol) {
  const ROWS = 32;
  const LEFT_COLS = 60;
  const RIGHT_COLS = 100;
  const TOTAL_COLS = 160;

  const m = Array.from({ length: ROWS }, (_, r) => {
    const row = new Array(TOTAL_COLS);
    for (let c = 0; c < LEFT_COLS; c++) row[c] = bg;
    for (let c = LEFT_COLS; c < TOTAL_COLS; c++) row[c] = ROLE_BLACK;
    return row;
  });

  // 左区中文
  if (chL) {
    const { layout } = layoutCN(chL, LEFT_COLS, 25, 24);
    if (layout && layout[0].length > 0) blitL(m, layout, 0, 0, cnL);
  }

  // 左区英文
  if (enL) {
    const t = enL.slice(0, 10);
    const em = enDot(t);
    if (em && em[0].length > 0) {
      const tw = t.length * 5 + (t.length - 1);
      const sc = Math.max(0, Math.floor((LEFT_COLS - tw) / 2));
      blitSp(m, em, 25, sc, enLr, 5, 1);
    }
  }

  // 左区描边
  const lo = m.map(r => r.slice(0, LEFT_COLS));
  addOutline(lo, bg, ol);
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < LEFT_COLS; c++)
      m[r][c] = lo[r][c];

  // 右区中文
  if (chR) {
    const { layout } = layoutCN(chR, RIGHT_COLS, 25, 24);
    if (layout && layout[0].length > 0) blitL(m, layout, 0, LEFT_COLS, cnR);
  }

  // 右区英文
  if (enR) {
    const t = enR.slice(0, 16);
    const em = enDot(t);
    if (em && em[0].length > 0) {
      const tw = t.length * 5 + (t.length - 1);
      const sc = LEFT_COLS + Math.max(0, Math.floor((RIGHT_COLS - tw) / 2));
      blitSp(m, em, 25, sc, enRr, 5, 1);
    }
  }

  return m;
}

function composeLower(chT, enT, cnR, enR) {
  const ROWS = 47;
  const COLS = 160;

  const m = Array.from({ length: ROWS }, () => new Array(COLS).fill(ROLE_BLACK));

  // 中文
  if (chT) {
    const { layout } = layoutCN(chT, COLS, 40, 40);
    if (layout && layout[0].length > 0) blitL(m, layout, 0, 0, cnR);
  }

  // 英文
  if (enT) {
    const t = enT.slice(0, 26);
    const em = enDot(t);
    if (em && em[0].length > 0) {
      const tw = t.length * 5 + (t.length - 1);
      const sc = Math.max(0, Math.floor((COLS - tw) / 2));
      blitSp(m, em, 40, sc, enR, 5, 1);
    }
  }

  return m;
}

// ==================== 渲染 ====================

function render(mat, pal, scale) {
  const c = $('c');
  const h = mat.length;
  const w = h > 0 ? mat[0].length : 0;

  c.width = w;
  c.height = h;
  c.style.width = (w * scale) + 'px';
  c.style.height = (h * scale) + 'px';

  const ctx = c.getContext('2d');
  const id = ctx.createImageData(w, h);
  const d = id.data;

  for (let r = 0; r < h; r++) {
    for (let cc = 0; cc < w; cc++) {
      const [rr, gg, bb] = pal[mat[r][cc]] || [0, 0, 0];
      const i = (r * w + cc) * 4;
      d[i] = rr;
      d[i + 1] = gg;
      d[i + 2] = bb;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(id, 0, 0);
}

// ==================== 调色板 ====================

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF];
}

function getPalette() {
  return {
    [ROLE_BG]:          hexToRgb($('bgColor').value),
    [ROLE_BLACK]:       [0, 0, 0],
    [ROLE_TEXT_UL_CN]:  hexToRgb($('tcULCn').value),
    [ROLE_TEXT_UL_EN]:  hexToRgb($('tcULEn').value),
    [ROLE_TEXT_UR_CN]:  hexToRgb($('tcURCn').value),
    [ROLE_TEXT_UR_EN]:  hexToRgb($('tcUREn').value),
    [ROLE_TEXT_LO_CN]:  hexToRgb($('tcLoCn').value),
    [ROLE_TEXT_LO_EN]:  hexToRgb($('tcLoEn').value),
    [ROLE_OUTLINE]:     [0, 0, 0],
  };
}

// ==================== 主流程 ====================

let genTimer = null;

async function generate() {
  clearTimeout(genTimer);
  genTimer = setTimeout(async () => {
    S('生成中...', '');
    try {
      if (!asciiFont || !gbMap) await loadFonts();
      await loadAllHZK();

      const p = getPalette();
      currentPalette = p;

      const upper = composeUpper(
        $('chLeft').value.trim(),
        $('enLeft').value.trim(),
        $('chRight').value.trim(),
        $('enRight').value.trim(),
        ROLE_BG,
        ROLE_TEXT_UL_CN, ROLE_TEXT_UL_EN,
        ROLE_TEXT_UR_CN, ROLE_TEXT_UR_EN,
        ROLE_OUTLINE,
      );

      const lower = composeLower(
        $('chLower').value.trim(),
        $('enLower').value.trim(),
        ROLE_TEXT_LO_CN,
        ROLE_TEXT_LO_EN,
      );

      fullMatrix = [...upper, new Array(160).fill(ROLE_BLACK), ...lower];
      render(fullMatrix, p, zoomLevel);
      $('info-bar').textContent = `${fullMatrix[0].length}×${fullMatrix.length} px · ${zoomLevel}x`;
      S('✓', 'success');
    } catch (e) {
      console.error(e);
      S(e.message, 'error');
    }
  }, 150);
}

// ==================== 下载 ====================

function downloadPNG() {
  if (!fullMatrix || !currentPalette) {
    S('请先生成', 'error');
    return;
  }
  const c = $('c');
  const ow = c.style.width;
  const oh = c.style.height;
  c.style.width = c.width + 'px';
  c.style.height = c.height + 'px';

  c.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'dotmatrix_160x80.png';
    a.click();
    URL.revokeObjectURL(url);
    c.style.width = ow;
    c.style.height = oh;
  }, 'image/png');

  S('下载中...', 'success');
}

// ==================== 缩放 ====================

function updateZoom() {
  zoomLevel = parseInt($('zoomSlider').value);
  $('zoomLabel').textContent = zoomLevel + 'x';
  if (fullMatrix && currentPalette) {
    const c = $('c');
    c.style.width = (c.width * zoomLevel) + 'px';
    c.style.height = (c.height * zoomLevel) + 'px';
    $('info-bar').textContent = `${c.width}×${c.height} px · ${zoomLevel}x`;
  }
}

// ==================== 初始化 ====================

async function init() {
  await loadFonts();
  await loadAllHZK();

  document.querySelectorAll('input').forEach(el => {
    el.addEventListener('input', generate);
    if (el.type === 'color') el.addEventListener('change', generate);
  });

  await generate();
}

window.addEventListener('DOMContentLoaded', init);
