// AI 圈選：用 SlimSAM（Segment Anything 的精簡版）在瀏覽器裡找出點到的物件範圍
// 免費、不用 API 金鑰。第一次使用會下載模型（約 15 MB），之後瀏覽器會記住

const TF_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js';
const MODEL_ID = 'Xenova/slimsam-77-uniform';

let libPromise = null;
let modelPromise = null;

function loadLib() {
  if (!libPromise) {
    libPromise = import(TF_URL).catch(() => {
      libPromise = null;
      throw new Error('AI 圈選工具載入失敗，請確認網路連線。');
    });
  }
  return libPromise;
}

// onProgress(已下載 MB, 總共 MB)
export function loadSam(onProgress) {
  if (!modelPromise) {
    modelPromise = (async () => {
      const T = await loadLib();
      T.env.allowLocalModels = false;
      const files = new Map();
      const progress_callback = (p) => {
        if (p.status === 'progress' && p.total) {
          files.set(p.file, { loaded: p.loaded, total: p.total });
          let loaded = 0, total = 0;
          for (const f of files.values()) { loaded += f.loaded; total += f.total; }
          onProgress && onProgress(loaded / 1048576, total / 1048576);
        }
      };
      const model = await T.SamModel.from_pretrained(MODEL_ID, { dtype: 'q8', device: 'wasm', progress_callback });
      const processor = await T.AutoProcessor.from_pretrained(MODEL_ID, { progress_callback });
      return { T, model, processor };
    })().catch((e) => {
      modelPromise = null;
      throw e instanceof Error && e.message.startsWith('AI') ? e : new Error('AI 模型下載失敗，請確認網路連線後再試一次。');
    });
  }
  return modelPromise;
}

// 先讓 AI 看一次整張圖（比較花時間），之後每次點選都很快
export async function analyzeImage(canvas) {
  const { T, model, processor } = await loadSam();
  const image = T.RawImage.fromCanvas(canvas).rgb();
  const inputs = await processor(image);
  const embeddings = await model.get_image_embeddings(inputs);
  return { inputs, embeddings, w: canvas.width, h: canvas.height };
}

// points: [{ x, y, include }]，座標是作品圖上的像素。
// AI 每次會給三種大小的選法（例如：一個針目、一片花邊、整件作品），全部回傳，由小到大排列：
// [{ mask: 每個像素是否被選到（1/0）, score: AI 的把握程度, area: 佔整張圖的比例 }]
export async function selectByPoints(handle, points) {
  const { T, model, processor } = await loadSam();
  const [rh, rw] = handle.inputs.reshaped_input_sizes[0];
  const sx = rw / handle.w, sy = rh / handle.h;
  const input_points = new T.Tensor('float32', Float32Array.from(points.flatMap((p) => [p.x * sx, p.y * sy])), [1, 1, points.length, 2]);
  const input_labels = new T.Tensor('int64', BigInt64Array.from(points.map((p) => BigInt(p.include ? 1 : 0))), [1, 1, points.length]);
  const out = await model({ ...handle.embeddings, input_points, input_labels });
  const masks = await processor.post_process_masks(out.pred_masks, handle.inputs.original_sizes, handle.inputs.reshaped_input_sizes);
  const scores = out.iou_scores.data;
  const n = handle.w * handle.h;
  const data = masks[0].data;
  const count = Math.min(scores.length, Math.floor(data.length / n));
  const options = [];
  for (let k = 0; k < count; k++) {
    const mask = Uint8Array.from(data.subarray(k * n, (k + 1) * n));
    let area = 0;
    for (let i = 0; i < n; i++) area += mask[i];
    options.push({ mask, score: scores[k], area: area / n });
  }
  return options.sort((a, b) => a.area - b.area);
}
