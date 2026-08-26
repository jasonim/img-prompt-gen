const normalized = (value) => String(value ?? '').normalize('NFC').toLocaleLowerCase('zh-CN')

export function flattenLibrary(library) {
  return [
    ...(library?.terms ?? []).map((entry) => ({ ...entry, type: 'term', label: entry.name, searchable: `${entry.name} ${entry.category} ${entry.responsibility}` })),
    ...(library?.recipes ?? []).map((entry) => ({ ...entry, type: 'recipe', label: entry.name, searchable: `${entry.name} ${entry.derivedPrompt}` })),
    ...(library?.prompts ?? []).map((entry) => ({ ...entry, type: 'prompt', label: entry.title, searchable: `${entry.title} ${entry.text}` }))
  ]
}

export function filterLibrary(library, { query = '', type = 'all', category = 'all' } = {}) {
  const needle = normalized(query.trim())
  return flattenLibrary(library).filter((entry) => {
    if (type !== 'all' && entry.type !== type) return false
    if (category !== 'all' && entry.category !== category) return false
    return !needle || normalized(entry.searchable).includes(needle)
  })
}

export function presentEntry(entry) {
  if (entry?.type === 'term' || ('name' in (entry ?? {}) && 'category' in (entry ?? {}))) {
    const category = CATEGORY_LABELS[entry.category] ?? entry.category
    const responsibility = RESPONSIBILITY_LABELS[entry.responsibility] ?? entry.responsibility
    return {
      title: entry.name,
      body: `${category} · ${responsibility}`,
      tags: ['原子词', category, responsibility]
    }
  }
  if (entry?.type === 'recipe' || 'derivedPrompt' in (entry ?? {})) {
    return {
      title: entry.name,
      body: entry.derivedPrompt,
      tags: ['组合配方', `${entry.termIds?.length ?? 0} 个原子词`]
    }
  }
  return {
    title: entry?.title ?? '未命名 Prompt',
    body: entry?.text ?? '',
    tags: ['常用 Prompt', '完整指令']
  }
}

export const CATEGORY_LABELS = Object.freeze({
  imaging: '成像',
  lighting: '光线',
  camera: '镜头',
  composition: '构图',
  subject: '主体',
  action: '动作',
  emotion: '情绪',
  clothing: '服装',
  scene: '场景',
  prop: '道具',
  color: '色彩',
  material: '材质',
  typography: '版式',
  other: '其他'
})

export const RESPONSIBILITY_LABELS = Object.freeze({
  image_texture: '画面质感',
  exposure: '曝光落点',
  light_color: '光线色彩',
  camera_angle: '机位角度',
  lens: '镜头特性',
  framing: '画面组织',
  pose: '身体姿态',
  gaze: '视线方向',
  emotion: '可读情绪',
  appearance: '人物外观',
  clothing: '服装设计',
  environment: '空间环境',
  prop: '道具关系',
  color: '色彩控制',
  material: '材质表现',
  layout: '版式关系',
  other: '其他机制'
})
