import {
  SCHEMA_VERSION,
  assertValidState,
  canonicalApprovalHash,
  sourceContentHash,
  validateState
} from './schemas.js'

function isPublished(collection, entity) {
  const human = entity.review?.human
  return human?.status === 'approved' && human.approvedContentHash === canonicalApprovalHash(collection, entity)
}

function runtimeTerm(term) {
  return {
    id: term.id,
    name: term.name,
    category: term.category,
    responsibility: term.responsibility,
    sourceCaptureIds: term.sourceCaptureIds,
    approvedAt: term.review.human.approvedAt,
    updatedAt: term.updatedAt
  }
}

function runtimeRecipe(recipe) {
  return {
    id: recipe.id,
    name: recipe.name,
    termIds: recipe.termIds,
    derivedPrompt: recipe.derivedPrompt,
    sourceCaptureIds: recipe.sourceCaptureIds,
    approvedAt: recipe.review.human.approvedAt,
    updatedAt: recipe.updatedAt
  }
}

function runtimePrompt(prompt) {
  return {
    id: prompt.id,
    title: prompt.title,
    text: prompt.text,
    sourceType: prompt.sourceType,
    sourceCaptureIds: prompt.sourceCaptureIds ?? [],
    approvedAt: prompt.review.human.approvedAt,
    updatedAt: prompt.updatedAt
  }
}

export function compileLibrary(state, { revision, generatedAt = new Date().toISOString() } = {}) {
  assertValidState(state)
  const report = validateState(state)
  const terms = state.terms.filter((term) => isPublished('terms', term)).map(runtimeTerm)
  const publishedTermIds = new Set(terms.map((term) => term.id))
  const recipes = state.recipes
    .filter((recipe) => isPublished('recipes', recipe) && recipe.termIds.every((id) => publishedTermIds.has(id)))
    .map(runtimeRecipe)
  const prompts = state.prompts.filter((prompt) => isPublished('prompts', prompt)).map(runtimePrompt)

  return {
    schemaVersion: SCHEMA_VERSION,
    sourceRevision: revision ?? 0,
    sourceContentHash: sourceContentHash(state),
    generatedAt,
    counts: {
      captures: state.captures.length,
      pendingCaptures: state.captures.filter((capture) => capture.processingStatus !== 'processed').length,
      sourceTerms: state.terms.length,
      sourceRecipes: state.recipes.length,
      sourcePrompts: state.prompts.length,
      machinePassed: report.machinePassed,
      humanApproved: report.humanApproved,
      publishedTerms: terms.length,
      publishedRecipes: recipes.length,
      publishedPrompts: prompts.length
    },
    terms,
    recipes,
    prompts
  }
}
