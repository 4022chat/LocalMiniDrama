'use strict';

/**
 * 从剧集行解析画风：优先使用 metadata 里由前端写入的完整提示词（与 styleOptions 一致），
 * 否则退回 dramas.style（通常为选项 value 或自定义短串）。
 */

function parseDramaMetadata(dramaRow) {
  if (!dramaRow?.metadata) return {};
  try {
    return typeof dramaRow.metadata === 'string' ? JSON.parse(dramaRow.metadata) : dramaRow.metadata;
  } catch (_) {
    return {};
  }
}

function styleFieldsFromDramaRow(dramaRow) {
  if (!dramaRow) return { zh: '', en: '', legacy: '' };
  const meta = parseDramaMetadata(dramaRow);
  const zh = meta.style_prompt_zh != null ? String(meta.style_prompt_zh).trim() : '';
  const en = meta.style_prompt_en != null ? String(meta.style_prompt_en).trim() : '';
  const legacy = dramaRow.style != null ? String(dramaRow.style).trim() : '';
  return { zh, en, legacy };
}

/**
 * 将剧集画风合并进 cfg.style（不修改原 cfg 引用外的对象）
 * @param {object} cfg
 * @param {{ style?: string, metadata?: string|object }|null|undefined} dramaRow
 */
function mergeCfgStyleWithDrama(cfg, dramaRow) {
  const { zh, en, legacy } = styleFieldsFromDramaRow(dramaRow);
  const base = { ...(cfg?.style || {}) };
  const hasMeta = !!(zh || en);
  if (hasMeta) {
    if (zh) base.default_style_zh = zh;
    else delete base.default_style_zh;
    if (en) base.default_style_en = en;
    else delete base.default_style_en;
    base.default_style = en || zh;
  } else if (legacy) {
    delete base.default_style_zh;
    delete base.default_style_en;
    base.default_style = legacy;
  }
  return { ...cfg, style: base };
}

/**
 * 分镜流式保存等：显式请求参数优先，否则用剧集 metadata/legacy，最后兜底 realistic
 */
function resolvedStreamStyleFromDrama(styleParam, dramaRow) {
  const s = (styleParam && String(styleParam).trim()) || '';
  if (s) return s;
  const { zh, en, legacy } = styleFieldsFromDramaRow(dramaRow);
  return en || zh || legacy || 'realistic';
}

module.exports = {
  mergeCfgStyleWithDrama,
  styleFieldsFromDramaRow,
  resolvedStreamStyleFromDrama,
  parseDramaMetadata,
};
