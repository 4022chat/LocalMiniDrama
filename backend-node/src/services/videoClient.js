// 与 Go pkg/video + VideoGenerationService 对齐：调用视频生成 API，支持纯文本(无参考图)
const fs = require('fs');
const path = require('path');
const aiConfigService = require('./aiConfigService');
let sharp; try { sharp = require('sharp'); } catch (_) { sharp = null; }

/**
 * 根据 provider 名推断视频接口规范（api_protocol 未设置时的兜底逻辑）
 */
function inferVideoProtocol(provider) {
  const p = String(provider || '').toLowerCase();
  if (p === 'dashscope') return 'dashscope';
  if (p === 'gemini' || p === 'google') return 'gemini';
  if (p === 'volces' || p === 'volcengine' || p === 'volc') return 'volcengine';
  if (p === 'vidu') return 'vidu';
  return 'openai';
}

// 使用前端设置的「默认」与「优先级」：listConfigs 已按 is_default DESC, priority DESC 排序
function getDefaultVideoConfig(db, preferredModel) {
  const configs = aiConfigService.listConfigs(db, 'video');
  const active = configs.filter((c) => c.is_active);
  if (active.length === 0) return null;
  if (preferredModel) {
    for (const c of active) {
      const models = Array.isArray(c.model) ? c.model : (c.model != null ? [c.model] : []);
      if (models.includes(preferredModel)) return c;
    }
  }
  const defaultOne = active.find((c) => c.is_default);
  return defaultOne != null ? defaultOne : active[0];
}

// 火山引擎视频 API 路径固定为 /contents/generations/tasks，base 读用户配置（并去掉错误子路径）
const VOLC_VIDEO_CREATE_PATH = '/contents/generations/tasks';
const VOLC_VIDEO_QUERY_PATH = '/contents/generations/tasks';

function getVolcVideoBase(config) {
  let base = (config.base_url || '').replace(/\/$/, '');
  base = base.replace(/\/(contents|video)\/.*$/i, '');
  return base || 'https://ark.cn-beijing.volces.com/api/v3';
}

function buildVideoUrl(config) {
  const p = (config.provider || '').toLowerCase();
  const isVolc = p === 'volces' || p === 'volcengine' || p === 'volc';
  if (isVolc) return getVolcVideoBase(config) + VOLC_VIDEO_CREATE_PATH;
  const base = (config.base_url || '').replace(/\/$/, '');
  let ep = config.endpoint || '/video/generations';
  if (!ep.startsWith('/')) ep = '/' + ep;
  return base + ep;
}

function buildQueryUrl(config, taskId) {
  const p = (config.provider || '').toLowerCase();
  const proto = (config.api_protocol || '').toLowerCase();
  const isDashScope = proto === 'dashscope' || p === 'dashscope';
  const isVolc = p === 'volces' || p === 'volcengine' || p === 'volc';
  const isSora = proto === 'sora';
  if (isVolc) return getVolcVideoBase(config) + VOLC_VIDEO_QUERY_PATH + '/' + encodeURIComponent(taskId);
  const base = (config.base_url || '').replace(/\/$/, '');
  let defaultEp;
  if (isSora) defaultEp = '/v1/videos/{taskId}';
  else if (isDashScope) defaultEp = '/api/v1/tasks/{taskId}';
  else defaultEp = '/video/task/{taskId}';
  let ep = config.query_endpoint || defaultEp;
  ep = String(ep).replace(/{taskId}/g, encodeURIComponent(taskId)).replace(/{task_id}/g, encodeURIComponent(taskId));
  if (!ep.startsWith('/')) ep = '/' + ep;
  return base + ep;
}

// 火山引擎常见显示名 → API 端点 ID 映射（API 只认小写+日期后缀格式）
const VOLC_MODEL_ALIASES = {
  'doubao-seedance-1.0-pro-fast':  'doubao-seedance-1-0-pro-250528',
  'doubao-seedance-1.0-pro':       'doubao-seedance-1-0-pro-250528',
  'doubao-seedance-1-0-pro':       'doubao-seedance-1-0-pro-250528',
  'doubao-seedance-1.0-lite':      'doubao-seedance-1-0-lite-250428',
  'doubao-seedance-1-0-lite':      'doubao-seedance-1-0-lite-250428',
  'doubao-seedance-1.5-pro':       'doubao-seedance-1-5-pro-251215',
  'doubao-seedance-1-5-pro':       'doubao-seedance-1-5-pro-251215',
};

function normalizeVolcModel(name) {
  if (!name) return name;
  return VOLC_MODEL_ALIASES[name.toLowerCase()] || name;
}

function getModelFromConfig(config, preferredModel) {
  const models = Array.isArray(config.model) ? config.model : (config.model != null ? [config.model] : []);
  if (preferredModel && models.includes(preferredModel)) return preferredModel;
  if (config.default_model && models.includes(config.default_model)) return config.default_model;
  return models[0] || '';
}

// 从 DashScope 任务查询响应中取视频 URL
function parseDashScopeVideoUrl(data) {
  const out = data?.output;
  if (!out) return null;
  if (out.video_url) return out.video_url;
  if (out.output && out.output.video_url) return out.output.video_url;
  const results = out.results || out.result;
  if (Array.isArray(results) && results[0]) {
    const r = results[0];
    if (r.video_url) return r.video_url;
    if (r.output && r.output.video_url) return r.output.video_url;
  }
  const choices = out.choices;
  if (Array.isArray(choices) && choices[0]) {
    const c = choices[0];
    const msg = c?.message?.content || c?.content;
    if (Array.isArray(msg)) {
      for (const m of msg) {
        if (m && (m.video_url || m.url)) return m.video_url || m.url;
      }
    }
  }
  return null;
}

const DASHSCOPE_VIDEO_GENERATION = '/api/v1/services/aigc/video-generation/video-synthesis';
const DASHSCOPE_IMAGE2VIDEO = '/api/v1/services/aigc/image2video/video-synthesis';

/**
 * 通义万相视频：按模型选择 endpoint 与请求体，异步轮询 /api/v1/tasks/{taskId}
 * - wan2.2-kf2v-flash: image2video, first_frame_url + last_frame_url
 * - wan2.6-t2v: video-generation, 仅 prompt（文生视频）
 * - wan2.6-i2v-flash: video-generation, prompt + img_url（首帧图生视频）
 * - wanx2.1-vace-plus: video-generation, function image_reference + ref_images_url（最多 3 张）
 * - wan2.6-r2v-flash: video-generation, reference_urls（最多 5 张）
 */
async function callDashScopeVideoApi(config, log, opts) {
  const {
    prompt,
    model: modelName,
    image_url,
    first_frame_url,
    last_frame_url,
    reference_urls,
    duration,
    files_base_url,
    storage_local_path,
    video_gen_id,
  } = opts;
  const base = (config.base_url || '').replace(/\/$/, '');
  const model = modelName || 'wan2.2-kf2v-flash';
  const dur = duration ? Number(duration) : 10;
  const baseUrl = (files_base_url || '').replace(/\/$/, '');
  const isLocalhost = baseUrl && /localhost|127\.0\.0\.1/i.test(baseUrl);

  function toPublicUrl(value) {
    if (!value || !String(value).trim()) return null;
    const s = String(value).trim();
    if (s.startsWith('http://') || s.startsWith('https://')) return s;
    if (baseUrl) return baseUrl + '/' + s.replace(/^\//, '');
    return s;
  }

  /** 本地调试：若 base_url 为 localhost，从本地磁盘读取图片并转为 base64，避免 DashScope 报 download image failed */
  function toImageInput(value) {
    if (!value || !String(value).trim()) return null;
    const s = String(value).trim();
    let relPath = null;
    if (s.startsWith('http://') || s.startsWith('https://')) {
      if (!isLocalhost || !storage_local_path) return s;
      const afterStatic = s.split('/static/')[1] || (baseUrl ? s.replace(baseUrl + '/', '').replace(baseUrl, '') : null);
      if (afterStatic) relPath = afterStatic.replace(/^\//, '');
      else return s;
    } else if (storage_local_path) {
      relPath = s.replace(/^\//, '');
    }
    if (!relPath) return toPublicUrl(s);
    const filePath = path.join(storage_local_path, relPath);
    try {
      if (!fs.existsSync(filePath)) return toPublicUrl(s);
      const buf = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp' }[ext] || 'image/png';
      return 'data:' + mime + ';base64,' + buf.toString('base64');
    } catch (e) {
      return toPublicUrl(s);
    }
  }

  let url;
  let body;

  if (model === 'wan2.2-kf2v-flash') {
    url = base + DASHSCOPE_IMAGE2VIDEO;
    const firstRaw = (first_frame_url && first_frame_url.trim()) || (image_url && image_url.trim());
    const lastRaw = (last_frame_url && last_frame_url.trim()) || firstRaw;
    const firstUrl = toImageInput(firstRaw);
    const lastUrl = toImageInput(lastRaw);
    if (!firstUrl || !lastUrl) {
      return { error: 'wan2.2-kf2v-flash 需要首帧与尾帧图片' };
    }
    body = {
      model,
      input: { prompt: prompt || '', first_frame_url: firstUrl, last_frame_url: lastUrl },
      parameters: { resolution: '480P', prompt_extend: true },
    };
  } else if (model === 'wan2.6-t2v') {
    url = base + DASHSCOPE_VIDEO_GENERATION;
    body = {
      model,
      input: { prompt: prompt || '' },
      parameters: { size: '1280*720', prompt_extend: true, duration: dur, shot_type: 'multi' },
    };
  } else if (model === 'wan2.6-i2v-flash') {
    url = base + DASHSCOPE_VIDEO_GENERATION;
    const imgRaw = (image_url && image_url.trim()) || (first_frame_url && first_frame_url.trim());
    const imgUrl = toImageInput(imgRaw);
    if (!imgUrl) return { error: 'wan2.6-i2v-flash 需要首帧图片' };
    body = {
      model,
      input: { prompt: prompt || '', img_url: imgUrl },
      parameters: { resolution: '720P', prompt_extend: true, duration: dur, shot_type: 'multi' },
    };
  } else if (model === 'wanx2.1-vace-plus') {
    url = base + DASHSCOPE_VIDEO_GENERATION;
    const rawRefs = Array.isArray(reference_urls) ? reference_urls.filter(Boolean).slice(0, 3) : [];
    const refs = rawRefs.map(toImageInput).filter(Boolean);
    if (refs.length === 0) return { error: 'wanx2.1-vace-plus 需要参考图（最多 3 张）' };
    body = {
      model,
      input: { function: 'image_reference', prompt: prompt || '', ref_images_url: refs },
      parameters: { prompt_extend: true, obj_or_bg: ['obj', 'bg'], size: '1280*720' },
    };
  } else if (model === 'wan2.6-r2v-flash') {
    url = base + DASHSCOPE_VIDEO_GENERATION;
    const rawRefs = Array.isArray(reference_urls) ? reference_urls.filter(Boolean).slice(0, 5) : [];
    const refs = rawRefs.map(toImageInput).filter(Boolean);
    if (refs.length === 0) return { error: 'wan2.6-r2v-flash 需要参考图或视频（最多 5 个）' };
    body = {
      model,
      input: { prompt: prompt || '', reference_urls: refs },
      parameters: { prompt_extend: true },
    };
  } else {
    return { error: '不支持的通义万相视频模型: ' + model };
  }

  const shorten = (v) => (v && v.startsWith('data:') ? '(base64 本地图)' : v);
  const imageUrlsInBody = body.input
    ? {
        first_frame_url: shorten(body.input.first_frame_url),
        last_frame_url: shorten(body.input.last_frame_url),
        img_url: shorten(body.input.img_url),
        ref_images_url: Array.isArray(body.input.ref_images_url) ? body.input.ref_images_url.map(shorten) : body.input.ref_images_url,
        reference_urls: Array.isArray(body.input.reference_urls) ? body.input.reference_urls.map(shorten) : body.input.reference_urls,
      }
    : {};
  log.info('DashScope 请求中的图片（base64 本地图 = 本地调试已转 base64，避免 download image failed）', {
    model,
    video_gen_id,
    files_base_url: baseUrl || '(未配置)',
    image_urls: imageUrlsInBody,
  });
  log.info('Video API request (DashScope)', { url: url.slice(0, 70), model, video_gen_id });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (config.api_key || ''),
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  if (!res.ok) {
    let errMsg = '视频生成请求失败: ' + res.status;
    try {
      const errJson = JSON.parse(raw);
      if (errJson.message) errMsg += ' - ' + errJson.message;
      else if (errJson.code) errMsg += ' - ' + errJson.code;
    } catch (_) {
      if (raw && raw.length) errMsg += ' - ' + raw.slice(0, 200);
    }
    log.error('DashScope video create failed', { status: res.status, body: raw.slice(0, 300), video_gen_id });
    return { error: errMsg };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { error: '视频生成返回格式异常' };
  }
  if (data.code) {
    return { error: data.message || data.code || '通义万相接口错误' };
  }
  const taskId = data?.output?.task_id;
  if (taskId) return { task_id: taskId, status: 'PENDING' };
  const videoUrl = parseDashScopeVideoUrl(data);
  if (videoUrl) return { video_url: videoUrl };
  return { error: '未返回 task_id 或 video_url' };
}

/**
 * 调用 Google Gemini Veo 视频生成 API（predictLongRunning 长运行任务）
 * 支持模型：veo-3.1-generate-preview / veo-3.0-generate-preview / veo-3.0-fast-generate-preview
 * 支持 t2v（纯文本）和 i2v（图片转视频）
 */
async function callGeminiVideoApi(config, log, opts) {
  const { prompt, duration, aspect_ratio, image_url, video_gen_id, files_base_url, storage_local_path, model } = opts;
  const apiKey = config.api_key || '';
  const base = (config.base_url || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
  const modelName = model || 'veo-3.0-generate-preview';

  // durationSeconds 限制在 5-8 秒
  const durationSec = Math.min(8, Math.max(5, Math.round(Number(duration) || 8)));
  const ratio = aspect_ratio || '16:9';

  const instance = { prompt: prompt || '' };

  // i2v：将图片转为 base64（Gemini 不支持 localhost URL，需本地读文件或 fetch 公网 URL）
  if (image_url && image_url.trim()) {
    let imageB64 = null;
    let mimeType = 'image/jpeg';
    const imgUrl = image_url.trim();
    if (imgUrl.startsWith('data:')) {
      const m = imgUrl.match(/^data:([\w/]+);base64,(.+)$/);
      if (m) { imageB64 = m[2]; mimeType = m[1]; }
    } else if ((files_base_url || '').match(/localhost|127\.0\.0\.1/i) && storage_local_path) {
      const baseUrl = (files_base_url || '').replace(/\/$/, '');
      const afterStatic = imgUrl.split('/static/')[1] || imgUrl.replace(baseUrl + '/', '').replace(baseUrl, '');
      const relPath = afterStatic ? afterStatic.replace(/^\//, '') : null;
      if (relPath) {
        const filePath = path.join(storage_local_path, relPath);
        try {
          if (fs.existsSync(filePath)) {
            const buf = fs.readFileSync(filePath);
            const ext = path.extname(filePath).toLowerCase();
            mimeType = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[ext] || 'image/jpeg';
            imageB64 = buf.toString('base64');
          }
        } catch (_) {}
      }
    } else {
      try {
        const imgRes = await fetch(imgUrl, { method: 'GET' });
        if (imgRes.ok) {
          const buf = Buffer.from(await imgRes.arrayBuffer());
          const ct = imgRes.headers.get('content-type') || 'image/jpeg';
          mimeType = ct.split(';')[0].trim();
          imageB64 = buf.toString('base64');
        }
      } catch (_) {}
    }
    if (imageB64) {
      instance.image = { bytesBase64Encoded: imageB64, mimeType };
    }
  }

  const body = {
    instances: [instance],
    parameters: {
      aspectRatio: ratio,
      durationSeconds: durationSec,
      sampleCount: 1,
    },
  };

  const url = `${base}/v1beta/models/${encodeURIComponent(modelName)}:predictLongRunning`;
  log.info('Gemini Video API request', { model: modelName, ratio, durationSec, video_gen_id, has_image: !!instance.image });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  if (!res.ok) {
    let errMsg = 'Gemini 视频生成请求失败: ' + res.status;
    try {
      const errJson = JSON.parse(raw);
      const msg = errJson.error?.message || errJson.message;
      if (msg) errMsg += ' - ' + String(msg).slice(0, 200);
    } catch (_) {
      if (raw) errMsg += ' - ' + raw.slice(0, 200);
    }
    log.error('Gemini Video API failed', { status: res.status, body: raw.slice(0, 300), video_gen_id });
    return { error: errMsg };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { error: 'Gemini 视频生成返回格式异常' };
  }

  // 返回 operation name 作为 task_id，后续由 pollVideoTask 轮询
  const operationName = data.name;
  if (operationName) {
    log.info('Gemini Video task created', { operation: operationName, video_gen_id });
    return { task_id: operationName, status: 'processing' };
  }
  return { error: 'Gemini 未返回 operation name，请检查 API Key 或模型权限' };
}

/**
 * 调用 Vidu 视频生成 API（官方 api.vidu.cn/ent/v2）
 * 认证：Authorization: Token {api_key}（非 Bearer）
 * 创建：POST /ent/v2/tasks
 * 轮询：GET /ent/v2/tasks/{id}/creations
 * 支持模型：viduq2 / viduq2-pro / viduq2-turbo / viduq3-pro
 */
async function callViduVideoApi(config, log, opts) {
  const { prompt, model, duration, aspect_ratio, image_url, video_gen_id, files_base_url, storage_local_path } = opts;
  const apiKey = config.api_key || '';
  const base = (config.base_url || 'https://api.vidu.cn').replace(/\/$/, '');
  const modelName = model || 'viduq2';

  // 时长：Vidu 支持 1-10 秒，默认 5
  const dur = Math.min(10, Math.max(1, Math.round(Number(duration) || 5)));
  // 画面比例：Vidu 支持 16:9 / 9:16 / 1:1 / 4:3 / 3:4
  const ratio = aspect_ratio || '16:9';

  const hasImage = !!(image_url && image_url.trim());
  const taskType = hasImage ? 'i2v' : 't2v';

  // 构建 prompts 数组
  const prompts = [{ type: 'text', content: prompt || '' }];

  if (hasImage) {
    let imgUrl = image_url.trim();
    // localhost 图片转为公网可访问 URL（Vidu 服务器需要能下载图片）
    if (/localhost|127\.0\.0\.1/i.test(imgUrl) && files_base_url && !/localhost|127/.test(files_base_url)) {
      const baseUrl = (files_base_url || '').replace(/\/$/, '');
      imgUrl = baseUrl + '/' + imgUrl.replace(/^.*?\/static\//, '');
    }
    prompts.push({ type: 'image', url: imgUrl });
  }

  const body = {
    type: taskType,
    model: modelName,
    input: {
      seed: -1,
      prompts,
      duration: dur,
      aspect_ratio: ratio,
      resolution: '720p',
      movement_amplitude: 'auto',
    },
  };

  const url = `${base}/ent/v2/tasks`;
  log.info('Vidu Video API request', { url: url.slice(0, 70), model: modelName, taskType, dur, ratio, video_gen_id });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Token ' + apiKey,
    },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  if (!res.ok) {
    let errMsg = 'Vidu 视频生成请求失败: ' + res.status;
    try {
      const errJson = JSON.parse(raw);
      const msg = errJson.message || errJson.err_code || errJson.error;
      if (msg) errMsg += ' - ' + String(msg).slice(0, 200);
    } catch (_) {
      if (raw) errMsg += ' - ' + raw.slice(0, 200);
    }
    log.error('Vidu Video API failed', { status: res.status, body: raw.slice(0, 300), video_gen_id });
    return { error: errMsg };
  }

  let data;
  try { data = JSON.parse(raw); } catch (_) {
    return { error: 'Vidu 视频生成返回格式异常' };
  }

  const taskId = data?.id || data?.task_id;
  if (!taskId) {
    log.error('Vidu Video API: no task id', { video_gen_id, raw: raw.slice(0, 300) });
    return { error: 'Vidu 未返回 task_id' };
  }
  log.info('Vidu Video task created', { task_id: taskId, state: data?.state, video_gen_id });
  return { task_id: taskId, status: data?.state || 'created' };
}

/**
 * Sora 兼容中转站（api_protocol = 'sora'）
 * body 格式：{ model, prompt, images:[url], orientation, size, duration, watermark }
 * orientation: portrait(9:16) | landscape(16:9) | square(1:1)
 * size: large | medium | small（可在配置 resolution 字段中填写，默认 large）
 */
async function callSoraVideoApi(config, log, opts) {
  const { prompt, model, duration, aspect_ratio, image_url, storage_local_path, video_gen_id } = opts;

  const base = (config.base_url || '').replace(/\/$/, '');
  let ep = config.endpoint || '/v1/videos';
  if (!ep.startsWith('/')) ep = '/' + ep;
  const url = base + ep;

  // seconds 只允许枚举值 4 / 8 / 12，就近取整
  const rawSec = duration ? Number(duration) : 4;
  const dur = rawSec <= 4 ? '4' : rawSec <= 8 ? '8' : '12';

  // aspect_ratio → size（只允许 4 个固定值：720x1280 / 1280x720 / 1024x1792 / 1792x1024）
  const sizeMap = {
    '9:16': '720x1280',  // 竖屏标准
    '3:4':  '1024x1792', // 竖屏高清
    '1:1':  '720x1280',  // 正方形用竖屏默认
    '16:9': '1280x720',  // 横屏标准
    '4:3':  '1280x720',  // 横屏标准
    '21:9': '1792x1024', // 横屏高清
  };
  const size = sizeMap[aspect_ratio || ''] || '720x1280';

  // ── 读取参考图 Buffer ────────────────────────────────────────────
  let imageBuffer = null;
  let imageMime = 'image/jpeg';
  let imageFilename = 'reference.jpg';
  const rawImgUrl = (image_url || '').trim();

  if (rawImgUrl) {
    if (rawImgUrl.startsWith('data:')) {
      const m = rawImgUrl.match(/^data:([\w/]+);base64,(.+)$/s);
      if (m) {
        imageMime = m[1];
        imageBuffer = Buffer.from(m[2], 'base64');
        const ext = imageMime.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
        imageFilename = `reference.${ext}`;
      } else {
        log.warn('[Sora] 无法解析 base64 参考图，跳过', { video_gen_id });
      }
    } else if (/localhost|127\.0\.0\.1/i.test(rawImgUrl)) {
      // localhost URL → 从本地磁盘直接读取
      try {
        const afterStatic = rawImgUrl.split('/static/')[1];
        if (afterStatic && storage_local_path) {
          const localFile = path.join(storage_local_path, afterStatic.replace(/^\//, ''));
          if (fs.existsSync(localFile)) {
            imageBuffer = fs.readFileSync(localFile);
            const ext = path.extname(localFile).toLowerCase();
            const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
            imageMime = mimeMap[ext] || 'image/jpeg';
            imageFilename = path.basename(localFile);
            log.info('[Sora] 本地参考图已读取', { file: localFile, size_kb: Math.round(imageBuffer.length / 1024), video_gen_id });
          } else {
            log.warn('[Sora] 本地参考图文件不存在', { file: localFile, video_gen_id });
          }
        }
      } catch (e) {
        log.warn('[Sora] 读取本地参考图失败', { error: e.message, video_gen_id });
      }
    } else {
      // 远程 URL → 下载
      try {
        const dlRes = await fetch(rawImgUrl);
        if (dlRes.ok) {
          const ct = (dlRes.headers.get('content-type') || '').split(';')[0].trim();
          imageMime = ct || 'image/jpeg';
          imageBuffer = Buffer.from(await dlRes.arrayBuffer());
          const ext = imageMime.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
          imageFilename = `reference.${ext}`;
          log.info('[Sora] 远程参考图已下载', { url: rawImgUrl, size_kb: Math.round(imageBuffer.length / 1024), video_gen_id });
        } else {
          log.warn('[Sora] 下载远程参考图失败', { status: dlRes.status, url: rawImgUrl, video_gen_id });
        }
      } catch (e) {
        log.warn('[Sora] 下载远程参考图异常', { error: e.message, video_gen_id });
      }
    }
  }

  // ── 将参考图 resize 到与 size 一致（Sora 要求尺寸完全匹配）────────
  if (imageBuffer && sharp) {
    try {
      const [targetW, targetH] = size.split('x').map(Number);
      const meta = await sharp(imageBuffer).metadata();
      if (meta.width !== targetW || meta.height !== targetH) {
        log.info('[Sora] 参考图尺寸不符，自动 resize', {
          from: `${meta.width}x${meta.height}`, to: size, video_gen_id,
        });
        imageBuffer = await sharp(imageBuffer)
          .resize(targetW, targetH, { fit: 'cover', position: 'centre' })
          .jpeg({ quality: 92 })
          .toBuffer();
        imageMime = 'image/jpeg';
        imageFilename = imageFilename.replace(/\.\w+$/, '.jpg');
        log.info('[Sora] 参考图 resize 完成', { size, size_kb: Math.round(imageBuffer.length / 1024), video_gen_id });
      } else {
        log.info('[Sora] 参考图尺寸已匹配', { size, video_gen_id });
      }
    } catch (e) {
      log.warn('[Sora] 参考图 resize 失败，使用原图', { error: e.message, video_gen_id });
    }
  }

  // ── 构造 multipart/form-data ─────────────────────────────────────
  const boundary = 'soraform_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

  const textFields = [
    ['model', model || 'sora-2'],
    ['prompt', prompt || ''],
    ['seconds', dur],
    ['size', size],
    ['watermark', 'false'],
    ['private', 'false'],
    ['character_url', ''],
    ['character_timestamps', ''],
    ['metadata', ''],
    ['character_from_task', ''],
    ['character_create', ''],
  ];

  const textPart = textFields
    .map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
    .join('');

  let bodyBuffer;
  if (imageBuffer) {
    const imgHeader = `--${boundary}\r\nContent-Disposition: form-data; name="input_reference"; filename="${imageFilename}"\r\nContent-Type: ${imageMime}\r\n\r\n`;
    bodyBuffer = Buffer.concat([
      Buffer.from(textPart, 'utf-8'),
      Buffer.from(imgHeader, 'utf-8'),
      imageBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8'),
    ]);
  } else {
    bodyBuffer = Buffer.concat([
      Buffer.from(textPart, 'utf-8'),
      Buffer.from(`--${boundary}--\r\n`, 'utf-8'),
    ]);
  }

  log.info('[Sora] Video API request', {
    url, model, size, seconds: dur,
    has_image: !!imageBuffer, image_file: imageBuffer ? imageFilename : null,
    prompt_len: (prompt || '').length,
    prompt_head: (prompt || '').slice(0, 200),
    video_gen_id,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      Authorization: 'Bearer ' + (config.api_key || ''),
    },
    body: bodyBuffer,
  });
  const raw = await res.text();
  log.info('[Sora] raw response', { status: res.status, raw: raw.slice(0, 1000), video_gen_id });

  if (!res.ok) {
    let errMsg = 'Sora 视频生成请求失败: ' + res.status;
    try {
      const errJson = JSON.parse(raw);
      const msg = errJson.error?.message || errJson.message || errJson.error;
      if (msg) errMsg += ' - ' + (typeof msg === 'string' ? msg : JSON.stringify(msg).slice(0, 200));
    } catch (_) {
      if (raw) errMsg += ' - ' + raw.slice(0, 200);
    }
    return { error: errMsg };
  }

  let data;
  try { data = JSON.parse(raw); } catch (e) {
    return { error: 'Sora 返回格式异常: ' + e.message + ' | raw: ' + raw.slice(0, 200) };
  }

  // 直接返回视频 URL
  const directUrl =
    data.video_url || data.url ||
    data.data?.video_url || data.data?.url ||
    data.result?.video_url || data.result?.url ||
    (Array.isArray(data.generations) && data.generations[0]?.url) ||
    (Array.isArray(data.data) && data.data[0]?.url);
  if (directUrl) {
    log.info('[Sora] 直接返回视频 URL', { video_url: directUrl, video_gen_id });
    return { video_url: directUrl };
  }

  // 异步任务 ID
  const taskId = data.id || data.task_id || data.request_id || data.data?.id || data.data?.task_id;
  if (taskId) {
    log.info('[Sora] 返回任务 ID', { task_id: taskId, status: data.status, video_gen_id });
    return { task_id: String(taskId), status: data.status || 'processing' };
  }

  log.error('[Sora] 未能解析 task_id 或 video_url', { data: JSON.stringify(data).slice(0, 500), video_gen_id });
  return { error: 'Sora 未返回 task_id 或 video_url，响应: ' + JSON.stringify(data).slice(0, 300) };
}

/**
 * 调用视频生成 API（ChatFire/豆包 或 通义万相）
 * @returns {Promise<{ task_id?: string, video_url?: string, error?: string }>}
 */
async function callVideoApi(db, log, opts) {
  const { prompt, model: preferredModel, duration, aspect_ratio, resolution, seed, camera_fixed, watermark, image_url, video_gen_id } = opts;
  const config = getDefaultVideoConfig(db, preferredModel);
  if (!config) {
    throw new Error('未配置视频模型，请在「AI 配置」中添加 video 类型且已启用的配置');
  }
  const model = getModelFromConfig(config, preferredModel);
  const provider = (config.provider || '').toLowerCase();
  // api_protocol 显式指定接口规范，优先级高于 provider 推断
  const protocol = (config.api_protocol || '').toLowerCase() || inferVideoProtocol(provider);

  if (protocol === 'dashscope') {
    return callDashScopeVideoApi(config, log, {
      prompt,
      model,
      image_url: opts.image_url,
      first_frame_url: opts.first_frame_url,
      last_frame_url: opts.last_frame_url,
      reference_urls: opts.reference_urls,
      duration: opts.duration,
      files_base_url: opts.files_base_url,
      storage_local_path: opts.storage_local_path,
      video_gen_id: opts.video_gen_id,
    });
  }

  if (protocol === 'gemini') {
    return callGeminiVideoApi(config, log, {
      prompt, model,
      duration: opts.duration,
      aspect_ratio,
      image_url: opts.image_url,
      video_gen_id: opts.video_gen_id,
      files_base_url: opts.files_base_url,
      storage_local_path: opts.storage_local_path,
    });
  }

  if (protocol === 'vidu') {
    return callViduVideoApi(config, log, {
      prompt, model,
      duration: opts.duration,
      aspect_ratio,
      image_url: opts.image_url,
      video_gen_id: opts.video_gen_id,
      files_base_url: opts.files_base_url,
      storage_local_path: opts.storage_local_path,
    });
  }

  // ── Sora 式中转站协议（api_protocol = 'sora'）─────────────────────
  // body 格式：{ model, prompt, images:[url], orientation, size, duration, watermark }
  if (protocol === 'sora') {
    return callSoraVideoApi(config, log, {
      prompt, model,
      duration: opts.duration,
      aspect_ratio,
      image_url: opts.image_url,
      resolution: opts.resolution,
      files_base_url: opts.files_base_url,
      storage_local_path: opts.storage_local_path,
      video_gen_id: opts.video_gen_id,
    });
  }

  const url = buildVideoUrl(config);
  const dur = duration ? Number(duration) : 5;
  const ratio = aspect_ratio || '16:9';

  const isVolc = protocol === 'volcengine';
  // 火山引擎 model 名称标准化（把显示名转成 API 端点 ID）
  const finalModel = isVolc ? normalizeVolcModel(model) : model;
  const hasImage = !!(image_url && image_url.trim());
  // 火山引擎：doubao-seedance-1-5-pro 不支持 r2v，必须显式传 task_type；单图用 i2v 且不用 reference_image 避免被识别为 r2v
  const volcTaskType = isVolc ? (hasImage ? 'i2v' : 't2v') : null;

  // 若图片为 localhost URL，火山服务器无法下载，转为 base64（与 DashScope 一致）
  let imageUrlForApi = image_url && image_url.trim();
  if (hasImage && imageUrlForApi && (opts.files_base_url || '').match(/localhost|127\.0\.0\.1/i) && opts.storage_local_path) {
    const baseUrl = (opts.files_base_url || '').replace(/\/$/, '');
    const afterStatic = imageUrlForApi.split('/static/')[1] || (baseUrl ? imageUrlForApi.replace(baseUrl + '/', '').replace(baseUrl, '') : null);
    const relPath = afterStatic ? afterStatic.replace(/^\//, '') : null;
    if (relPath) {
      const filePath = path.join(opts.storage_local_path, relPath);
      try {
        if (fs.existsSync(filePath)) {
          const buf = fs.readFileSync(filePath);
          const ext = path.extname(filePath).toLowerCase();
          const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp' }[ext] || 'image/png';
          imageUrlForApi = 'data:' + mime + ';base64,' + buf.toString('base64');
        }
      } catch (_) {}
    }
  }

  // ratio、duration 等作为独立顶层字段传入（火山引擎/ChatFire 官方接口格式）
  const body = {
    model: finalModel,
    content: [{ type: 'text', text: prompt || '' }],
    ratio,
    duration: dur,
    watermark: (watermark != null) ? Boolean(watermark) : false,
  };
  if (resolution) body.resolution = resolution;
  if (seed != null) body.seed = Number(seed);
  if (camera_fixed != null) body.camera_fixed = Boolean(camera_fixed);
  if (volcTaskType) body.task_type = volcTaskType;
  if (hasImage && imageUrlForApi) {
    const imagePart = { type: 'image_url', image_url: { url: imageUrlForApi } };
    if (volcTaskType !== 'i2v') imagePart.role = 'reference_image';
    body.content.push(imagePart);
  }

  log.info('Video API request', {
    url,
    model,
    video_gen_id,
    task_type: body.task_type,
    request_body: JSON.stringify({ ...body, content: body.content?.map(c => c.type === 'image_url' ? { ...c, image_url: { url: '(omitted)' } } : c) }),
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (config.api_key || ''),
    },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  log.info('Video API raw response', { video_gen_id, status: res.status, raw: raw.slice(0, 1000) });
  if (!res.ok) {
    log.error('Video API failed', { status: res.status, body: raw.slice(0, 500) });
    let errMsg = '视频生成请求失败: ' + res.status;
    try {
      const errJson = JSON.parse(raw);
      const msg = errJson.error?.message || errJson.message || errJson.error;
      if (msg) errMsg += ' - ' + (typeof msg === 'string' ? msg : JSON.stringify(msg).slice(0, 200));
    } catch (_) {
      if (raw && raw.length) errMsg += ' - ' + raw.slice(0, 200);
    }
    return { error: errMsg };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    log.error('Video API response JSON parse failed', { video_gen_id, raw: raw.slice(0, 1000), parse_error: e.message });
    return { error: '视频生成返回格式异常: ' + e.message + ' | raw: ' + raw.slice(0, 200) };
  }
  log.info('Video API parsed response', { video_gen_id, data: JSON.stringify(data).slice(0, 500) });
  const taskId = data.id || data.task_id || (data.data && data.data.id);
  const status = data.status || (data.data && data.data.status);
  const videoUrl = data.video_url || (data.data && data.data.video_url) || (data.content && data.content.video_url);
  if (videoUrl) {
    log.info('Video API returned video_url directly', { video_gen_id, video_url: videoUrl });
    return { video_url: videoUrl };
  }
  if (taskId) {
    log.info('Video API returned task_id', { video_gen_id, task_id: taskId, status });
    return { task_id: taskId, status: status || 'processing' };
  }
  log.error('Video API: no task_id or video_url in response', { video_gen_id, data: JSON.stringify(data).slice(0, 500) });
  return { error: '未返回 task_id 或 video_url，完整响应: ' + JSON.stringify(data).slice(0, 300) };
}

/**
 * 轮询任务状态直到完成或失败（兼容豆包/ChatFire 与 通义万相 DashScope）
 */
async function pollVideoTask(db, log, videoGenId, taskId, config, maxAttempts = 300, intervalMs = 10000) {
  const provider = (config.provider || '').toLowerCase();
  const protocol = (config.api_protocol || '').toLowerCase() || inferVideoProtocol(provider);
  const isDashScope = protocol === 'dashscope';
  const isGemini = protocol === 'gemini';
  const isVidu = protocol === 'vidu';
  const isSora = protocol === 'sora';
  const queryUrl = () => buildQueryUrl(config, taskId);
  log.info('[poll] 开始轮询', { video_gen_id: videoGenId, task_id: taskId, protocol, poll_url: queryUrl() });
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      let url, headers;
      if (isGemini) {
        const base = (config.base_url || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
        url = `${base}/v1beta/${taskId}`;
        headers = { 'x-goog-api-key': config.api_key || '' };
      } else if (isVidu) {
        // Vidu 轮询：GET /ent/v2/tasks/{id}/creations
        const base = (config.base_url || 'https://api.vidu.cn').replace(/\/$/, '');
        url = `${base}/ent/v2/tasks/${encodeURIComponent(taskId)}/creations`;
        headers = { Authorization: 'Token ' + (config.api_key || '') };
      } else {
        url = queryUrl();
        headers = { Authorization: 'Bearer ' + (config.api_key || '') };
      }
      log.info('[poll] 发起轮询请求', { video_gen_id: videoGenId, attempt, url });
      const res = await fetch(url, { method: 'GET', headers });
      const raw = await res.text();
      log.info('[poll] 轮询响应', { video_gen_id: videoGenId, attempt, status: res.status, raw: raw.slice(0, 600) });
      if (!res.ok) {
        log.warn('[poll] 轮询失败 (non-200)', { video_gen_id: videoGenId, attempt, status: res.status, raw: raw.slice(0, 300) });
        continue;
      }
      const data = JSON.parse(raw);

      if (isSora) {
        const status = (data.status || '').toLowerCase();
        log.info('[Sora poll] 任务状态', { video_gen_id: videoGenId, attempt, status, progress: data.progress, id: data.id });
        if (status === 'failed' || status === 'error') {
          const msg = data.error?.message || data.error || data.message || 'Sora 视频任务失败';
          log.warn('[Sora poll] 任务失败', { video_gen_id: videoGenId, msg, data: JSON.stringify(data).slice(0, 300) });
          return { error: String(msg) };
        }
        // succeeded / completed / done → 取视频 URL
        const videoUrl =
          data.video_url || data.url || data.output_url ||
          data.data?.video_url || data.data?.url ||
          data.result?.url || data.result?.video_url ||
          (Array.isArray(data.videos) && data.videos[0]?.url) ||
          (Array.isArray(data.generations) && data.generations[0]?.url);
        if (videoUrl) {
          log.info('[Sora poll] 视频完成', { video_gen_id: videoGenId, video_url: videoUrl });
          return { video_url: videoUrl };
        }
        if (status === 'succeeded' || status === 'completed' || status === 'done') {
          log.warn('[Sora poll] 状态为完成但未找到 video_url', { video_gen_id: videoGenId, data: JSON.stringify(data).slice(0, 500) });
          return { error: 'Sora 视频生成完成但未返回视频地址，响应: ' + JSON.stringify(data).slice(0, 300) };
        }
        // queued / processing / running → 继续等待
        continue;
      }

      if (isVidu) {
        const state = data?.state || data?.status;
        if (state === 'failed') {
          const msg = data?.err_code || data?.message || 'Vidu 视频任务失败';
          log.warn('Vidu video task failed', { video_gen_id: videoGenId, task_id: taskId, state, msg });
          return { error: String(msg) };
        }
        if (state === 'success') {
          const videoUrl = data?.creations?.[0]?.url;
          if (videoUrl) return { video_url: videoUrl };
          return { error: 'Vidu 视频生成完成但未返回视频地址' };
        }
        // state: created / queueing / processing → 继续等待
        continue;
      }

      if (isGemini) {
        if (data.error) {
          return { error: data.error.message || 'Gemini 视频任务失败' };
        }
        if (data.done === true) {
          const videoUri = data.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
          if (videoUri) return { video_url: videoUri };
          return { error: 'Gemini 视频生成完成但未返回视频地址' };
        }
        continue;
      }

      if (isDashScope) {
        const taskStatus = data?.output?.task_status;
        const videoUrl = parseDashScopeVideoUrl(data);
        if (videoUrl) return { video_url: videoUrl };
        if (taskStatus === 'FAILED' || taskStatus === 'CANCELED') {
          const msg = data?.message || data?.output?.message || taskStatus;
          log.warn('DashScope 视频任务失败（若为 download image failed，多为图片 URL 非外网可访问，如 localhost）', {
            video_gen_id: videoGenId,
            task_id: taskId,
            task_status: taskStatus,
            message: msg,
            output: data?.output,
          });
          return { error: msg || '通义万相任务失败' };
        }
        continue;
      }
      const status = data.status || (data.data && data.data.status);
      // 兼容多种字段名：标准 video_url / Sora url / generations[].url / data.data.*
      const videoUrl =
        data.video_url || data.url ||
        (data.data && (data.data.video_url || data.data.url)) ||
        (data.content && data.content.video_url) ||
        (Array.isArray(data.generations) && data.generations[0]?.url) ||
        (Array.isArray(data.data) && data.data[0]?.url);
      const errMsg = data.error && (typeof data.error === 'string' ? data.error : data.error.message);
      if (videoUrl) return { video_url: videoUrl };
      if (status === 'failed' || status === 'error' || status === 'cancelled' || errMsg) return { error: errMsg || status || '任务失败' };
    } catch (e) {
      log.warn('Video poll request failed', { attempt, error: e.message });
    }
  }
  return { error: '视频生成超时' };
}

module.exports = {
  getDefaultVideoConfig,
  callVideoApi,
  pollVideoTask,
};
