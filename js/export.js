// 匯出：配色圖片加上品牌色號清單，每個色號標出「已有」或「需要買」
import { h, modal, toast } from './ui.js';
import { readableTextOn } from './color.js';
import { taipeiDate } from './data.js';

const FONT = '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif';

function loadImg(src) {
  return new Promise((resolve) => {
    if (!src) return resolve(null);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

export async function buildExportCanvas({ image, rows, name }) {
  const W = Math.max(900, image.width);
  const pad = Math.round(W * 0.04);
  const imgW = W - pad * 2;
  const imgH = Math.round((image.height / image.width) * imgW);
  const rowH = Math.round(W * 0.075);
  const headH = Math.round(W * 0.07);
  const H = pad + headH + imgH + pad + rows.length * rowH + pad;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#f7f8f6';
  x.fillRect(0, 0, W, H);
  // 標題
  x.fillStyle = '#1f2b2a';
  x.font = `700 ${Math.round(W * 0.03)}px ${FONT}`;
  x.textBaseline = 'middle';
  x.fillText(name, pad, pad + headH * 0.4);
  x.fillStyle = '#5d6d6a';
  x.font = `${Math.round(W * 0.018)}px ${FONT}`;
  x.fillText(taipeiDate(), pad, pad + headH * 0.82);
  // 圖
  const iy = pad + headH;
  x.drawImage(image, pad, iy, imgW, imgH);
  // 清單
  let y = iy + imgH + pad;
  const thumbs = await Promise.all(rows.map((r) => loadImg(r.thumb)));
  const s = rowH * 0.72;
  rows.forEach((r, i) => {
    const cy = y + rowH / 2;
    // 編號
    x.beginPath();
    x.arc(pad + s * 0.35, cy, s * 0.35, 0, Math.PI * 2);
    x.fillStyle = '#1f2b2a';
    x.fill();
    x.fillStyle = '#fff';
    x.font = `700 ${Math.round(s * 0.4)}px ${FONT}`;
    x.textAlign = 'center';
    x.fillText(String(r.n), pad + s * 0.35, cy + 1);
    x.textAlign = 'left';
    // 色塊
    const tx = pad + s * 0.9;
    const hex = r.yarn ? r.yarn.hex : r.origHex;
    if (thumbs[i]) x.drawImage(thumbs[i], tx, cy - s / 2, s, s);
    else {
      x.fillStyle = hex;
      x.fillRect(tx, cy - s / 2, s, s);
    }
    x.strokeStyle = 'rgba(0,0,0,.12)';
    x.strokeRect(tx + 0.5, cy - s / 2 + 0.5, s - 1, s - 1);
    // 文字
    const textX = tx + s + pad * 0.5;
    x.fillStyle = '#1f2b2a';
    x.font = `700 ${Math.round(s * 0.34)}px ${FONT}`;
    const main = r.yarn ? `${r.yarn.brandName || ''} ${r.yarn.code}`.trim() : '維持原色';
    x.fillText(main, textX, cy - s * 0.17);
    x.fillStyle = '#5d6d6a';
    x.font = `${Math.round(s * 0.28)}px ${FONT}`;
    x.fillText(r.yarn ? r.yarn.name || '' : '沒有換線', textX, cy + s * 0.25);
    // 已有／需要買
    if (r.yarn && r.yarn.live) {
      const label = r.yarn.owned ? '已有' : '需要買';
      const bg = r.yarn.owned ? '#2c6a6e' : '#c9892b';
      x.font = `700 ${Math.round(s * 0.3)}px ${FONT}`;
      const tw = x.measureText(label).width + s * 0.5;
      const bx = W - pad - tw, bh = s * 0.55;
      x.fillStyle = bg;
      roundRect(x, bx, cy - bh / 2, tw, bh, bh / 2);
      x.fill();
      x.fillStyle = readableTextOn(bg);
      x.textAlign = 'center';
      x.fillText(label, bx + tw / 2, cy + 1);
      x.textAlign = 'left';
    }
    // 分隔線
    x.strokeStyle = 'rgba(0,0,0,.08)';
    x.beginPath();
    x.moveTo(pad, y + rowH);
    x.lineTo(W - pad, y + rowH);
    x.stroke();
    y += rowH;
  });
  return c;
}

function roundRect(x, px, py, w, hh, r) {
  x.beginPath();
  x.moveTo(px + r, py);
  x.arcTo(px + w, py, px + w, py + hh, r);
  x.arcTo(px + w, py + hh, px, py + hh, r);
  x.arcTo(px, py + hh, px, py, r);
  x.arcTo(px, py, px + w, py, r);
  x.closePath();
}

export async function openExport(opts) {
  const c = await buildExportCanvas(opts);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const fileName = `${opts.name}.png`;
  const file = new File([blob], fileName, { type: 'image/png' });
  const url = URL.createObjectURL(blob);
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
  const actions = [{ label: '關閉', value: null, kind: 'ghost' }];
  if (canShare) actions.push({ label: '分享', value: 'share', kind: '' });
  actions.push({ label: '下載圖片', value: 'download', kind: 'primary' });
  const v = await modal({
    title: '匯出配色',
    wide: true,
    body: h('div', { class: 'export-preview' }, h('img', { src: url, alt: '匯出預覽' })),
    actions,
  });
  if (v === 'download') {
    const a = h('a', { href: url, download: fileName });
    document.body.append(a);
    a.click();
    a.remove();
    toast('已下載圖片');
  } else if (v === 'share') {
    try {
      await navigator.share({ files: [file], title: opts.name });
    } catch (e) {
      if (e && e.name !== 'AbortError') toast('分享沒有成功，可以改用下載圖片', 'error');
    }
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
