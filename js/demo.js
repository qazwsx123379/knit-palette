// 示範模式（網址加 ?demo）：放兩個假品牌，方便試用與測試，資料不會保存

const BRANDS = [
  {
    id: 'demo-a', name: '示範品牌 A',
    colors: [['101', '莓果紅', '#a8323e'], ['102', '南瓜橘', '#d9782d'], ['103', '芥末黃', '#d6b23a'], ['104', '苔蘚綠', '#6b7d3a'], ['105', '湖水綠', '#2f8a83'], ['106', '海軍藍', '#23395d'], ['107', '燕麥', '#e3d7c1'], ['108', '炭灰', '#3b3b3d']],
  },
  {
    id: 'demo-b', name: '示範品牌 B',
    colors: [['B01', 'Rose', '#d9959c'], ['B02', 'Lilac', '#a898c7'], ['B03', 'Sky', '#8fb8d8'], ['B04', 'Mint', '#a8d5bc'], ['B05', 'Cream', '#f3ecd9'], ['B06', 'Cocoa', '#6b4a3a']],
  },
];

function fakeThumb(hex) {
  const c = document.createElement('canvas');
  c.width = c.height = 96;
  const x = c.getContext('2d');
  x.fillStyle = hex;
  x.fillRect(0, 0, 96, 96);
  // 斜紋讓它看起來像一捲線
  x.strokeStyle = 'rgba(0,0,0,.12)';
  x.lineWidth = 3;
  for (let i = -96; i < 96; i += 9) {
    x.beginPath();
    x.moveTo(i, 96);
    x.lineTo(i + 96, 0);
    x.stroke();
  }
  return c.toDataURL('image/jpeg', 0.8);
}

export async function seedDemo(store) {
  const library = { version: 1, brands: [], yarns: [] };
  const files = {};
  for (const b of BRANDS) {
    library.brands.push({ id: b.id, name: b.name });
    const thumbs = {};
    b.colors.forEach(([code, name, hex], i) => {
      const id = `${b.id}-${code}`;
      library.yarns.push({ id, brandId: b.id, code, name, hex, fav: i === 1, owned: i % 3 === 0 });
      thumbs[id] = fakeThumb(hex);
    });
    files[`knit/thumbs/${b.id}.json`] = JSON.stringify(thumbs);
  }
  files['knit/library.json'] = JSON.stringify(library);
  await store.commit(files, 'demo');
}
