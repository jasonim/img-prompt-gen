export function buildOrganizePayload({ expectedRevision, terms, recipe }) {
  if (!Number.isInteger(expectedRevision)) throw new Error('缺少当前数据版本，请刷新后重试')
  if (!Array.isArray(terms) || terms.length === 0) throw new Error('至少添加一个原子词')
  for (const [index, term] of terms.entries()) {
    if (!term.name?.trim()) throw new Error(`第 ${index + 1} 个词缺少名称`)
    if (!term.category || !term.responsibility) throw new Error(`第 ${index + 1} 个词必须分别判断浏览分类和视觉职责`)
  }
  const normalizedRecipe = recipe?.name?.trim()
    ? {
        id: recipe.id,
        name: recipe.name.trim(),
        termIds: terms.map((term) => term.id),
        derivedPrompt: recipe.derivedPrompt
      }
    : null
  if (normalizedRecipe && !normalizedRecipe.derivedPrompt?.trim()) throw new Error('组合配方必须保留完整 Prompt')
  return {
    expectedRevision,
    terms: terms.map((term) => ({
      id: term.id,
      name: term.name,
      category: term.category,
      responsibility: term.responsibility
    })),
    recipe: normalizedRecipe
  }
}
